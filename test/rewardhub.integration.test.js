const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { DatabaseSync } = require("node:sqlite");

const projectRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rewardhub-test-"));
const databasePath = path.join(tempRoot, "legacy-rewardhub.db");
const adminEmail = "admin@example.test";
const adminPassword = "test-admin-password-123";
const postgresMode = process.env.REWARDHUB_POSTGRES_TEST === "1";
let bootstrapPool;
let appPool;
let testSchema;
let app;
let db;
let initializeDatabase;

function createLegacyDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (name,email,password_hash,role,balance) VALUES
      ('Legacy Member','legacy@example.test','not-used','user',55);
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, advertiser TEXT NOT NULL,
      description TEXT DEFAULT '', video_url TEXT NOT NULL, destination_url TEXT DEFAULT '',
      reward INTEGER NOT NULL DEFAULT 10, duration_seconds INTEGER NOT NULL DEFAULT 5,
      budget INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO campaigns(title,advertiser,video_url,destination_url,reward,duration_seconds,budget)
      VALUES ('Legacy demo campaign','Example Brand','https://example.test/video.mp4','https://example.test',25,5,10000);
    CREATE TABLE views (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, campaign_id INTEGER NOT NULL,
      reward INTEGER NOT NULL, watched_seconds INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id,campaign_id), FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
    );
    CREATE TABLE withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount INTEGER NOT NULL,
      method TEXT NOT NULL, account_details TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id)
    );
    INSERT INTO withdrawals(user_id,amount,method,account_details) VALUES (1,20,'Bank transfer','legacy-private-account-details');
    CREATE TABLE watch_sessions (token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,campaign_id INTEGER NOT NULL,started_at INTEGER NOT NULL);
    CREATE TABLE session_store (sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE rate_limit_hits (bucket TEXT NOT NULL,hit_at INTEGER NOT NULL);
  `);
  db.close();
}

process.env.NODE_ENV = "development";
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_EMAIL = adminEmail;
process.env.ADMIN_PASSWORD = adminPassword;
process.env.SESSION_SECRET = "rewardhub-test-session-secret-32-chars-minimum";
process.env.BANK_DETAILS_ENCRYPTION_KEY = "rewardhub-test-bank-encryption-key";
process.env.ADVERTISER_FUNDING_INSTRUCTIONS = "Test only: use the isolated payment simulation account.";
if (postgresMode) {
  if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a local, disposable PostgreSQL database before running the PostgreSQL route tests.");
  const testUrl = new URL(process.env.TEST_DATABASE_URL);
  if (!/(^|_)test($|_)/i.test(testUrl.pathname.replace(/^\//, "")) || !["localhost", "127.0.0.1", "::1"].includes(testUrl.hostname)) {
    throw new Error("PostgreSQL route tests only run against a loopback database whose name includes 'test'.");
  }
  testSchema = `rewardhub_route_test_${crypto.randomBytes(6).toString("hex")}`;
  const scopedUrl = new URL(process.env.TEST_DATABASE_URL);
  scopedUrl.searchParams.set("options", `-c search_path=${testSchema}`);
  process.env.DATABASE_URL = scopedUrl.toString();
  process.env.NODE_ENV = "development";
  bootstrapPool = new (require("pg").Pool)({ connectionString: process.env.TEST_DATABASE_URL });
  ({ app, db, pool: appPool, initializeDatabase } = require(path.join(projectRoot, "server.js")));
  before(async () => {
    await bootstrapPool.query(`CREATE SCHEMA "${testSchema}"`);
    console.log(`Using isolated PostgreSQL route-test schema: ${testSchema}`);
    await initializeDatabase();
    const admin = await db.prepare("SELECT role FROM users WHERE email = ?").get(adminEmail);
    assert.equal(admin?.role, "admin", "test admin should be provisioned without elevating another account");
    assert.throws(() => require("pg").types.getTypeParser(20)("9007199254740992"), RangeError);
    assert.throws(() => require("pg").types.getTypeParser(1700)("9007199254740992"), RangeError);
    const legacy = await db.prepare(`INSERT INTO users (name,email,password_hash,role,balance,legacy_balance_kobo)
      VALUES ('Legacy Member','legacy@example.test','not-used','user',55,5500)`).run();
    const campaign = await db.prepare(`INSERT INTO campaigns
      (title,advertiser,video_url,destination_url,reward,duration_seconds,budget,active,status,approval_status,funding_status)
      VALUES ('Legacy demo campaign','Example Brand','https://example.test/video.mp4','https://example.test',25,5,10000,0,'paused','pending_review','unfunded')`).run();
    await db.prepare(`INSERT INTO withdrawals (user_id,amount,method,account_details,status,request_reference,amount_rc)
      VALUES (?,20,'Bank transfer','legacy-private-account-details','legacy_review','LEGACY-WD-1',0)`).run(legacy.lastInsertRowid);
    if (!campaign.lastInsertRowid) throw new Error("Could not seed isolated PostgreSQL route-test campaign.");
  });
  after(async () => {
    await appPool.end();
    await bootstrapPool.end();
  });
} else {
  createLegacyDatabase(databasePath);
  ({ app, db } = require(path.join(projectRoot, "server-sqlite.js")));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

class ApiClient {
  constructor(baseUrl) { this.baseUrl = baseUrl; this.cookie = ""; this.csrfToken = ""; }
  async updateCookie(response) {
    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) this.cookie = cookies.map(value => value.split(";")[0]).join("; ");
  }
  async request(method, route, body, headers = {}) {
    if (method !== "GET" && !this.csrfToken) {
      const response = await fetch(this.baseUrl + "/api/csrf", { headers: this.cookie ? { Cookie: this.cookie } : {} });
      await this.updateCookie(response);
      this.csrfToken = (await response.json()).csrfToken;
    }
    const requestHeaders = { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.csrfToken ? { "X-CSRF-Token": this.csrfToken } : {}), ...headers };
    let response;
    try {
      response = await fetch(this.baseUrl + route, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw new Error(`${method} ${route} failed: ${error.message}`, { cause: error });
    }
    await this.updateCookie(response);
    const data = await response.json().catch(() => ({}));
    if (route === "/api/register" || route === "/api/login") this.csrfToken = "";
    return { response, data };
  }
  get(route) { return this.request("GET", route); }
  post(route, body, headers) { return this.request("POST", route, body, headers); }
  patch(route, body) { return this.request("PATCH", route, body); }
}

async function eventuallyReady(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("RewardHub server exited before startup.");
    try { const response = await fetch(baseUrl + "/api/public/settings"); if (response.ok) return; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error("RewardHub server did not become ready.");
}

function assertStatus(result, status, message = JSON.stringify(result.data)) {
  assert.equal(result.response.status, status, message);
}

test("legacy migration and funded rewards, ledger, advertiser review, and withdrawals", async t => {
  const originalFetch = global.fetch;
  const originalResendKey = process.env.RESEND_API_KEY;
  const originalEmailFrom = process.env.EMAIL_FROM;
  const originalAppBaseUrl = process.env.APP_BASE_URL;
  let sentEmail = null;
  process.env.RESEND_API_KEY = "re_test_only";
  process.env.EMAIL_FROM = "RewardHub Tests <test@example.test>";
  process.env.APP_BASE_URL = "https://rewardhub.example.test";
  global.fetch = async (input, options) => {
    if (String(input) === "https://api.resend.com/emails") {
      sentEmail = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: "test-email-id" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, options);
  };

  let server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    global.fetch = originalFetch;
    if (originalResendKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalResendKey;
    if (originalEmailFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = originalEmailFrom;
    if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = originalAppBaseUrl;
    await new Promise(resolve => server.close(resolve));
    if (!postgresMode) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const admin = new ApiClient(baseUrl);
  assertStatus(await admin.post("/api/login", { email: adminEmail, password: adminPassword }), 200);
  // Keep this lifecycle fixture's 10,000 RC payout below the new production minimum.
  assertStatus(await admin.patch("/api/admin/settings", { settings: { minimum_withdrawal_rc: 10000 } }), 200);
  const legacyUsers = await admin.get("/api/admin/users");
  assertStatus(legacyUsers, 200);
  const legacy = legacyUsers.data.find(user => user.email === "legacy@example.test");
  assert.equal(legacy.available_rc, 0);
  assert.equal(legacy.legacy_balance_kobo, 5500);
  const oldCampaigns = await admin.get("/api/admin/campaigns");
  assertStatus(oldCampaigns, 200);
  assert.equal(oldCampaigns.data[0].active, 0);
  assert.equal(oldCampaigns.data[0].funding_status, "unfunded");
  const oldWithdrawals = await admin.get("/api/admin/withdrawals");
  assert.equal(oldWithdrawals.data[0].status, "legacy_review");
  assert.equal(JSON.stringify(oldWithdrawals.data[0]).includes("legacy-private-account-details"), false);

  const user = new ApiClient(baseUrl);
  const registration = await user.post("/api/register", { name: "Test Member", email: "member@example.test", password: "member-password-123", accountType: "user" });
  assertStatus(registration, 200);
  const unknownRecovery = await user.post("/api/password/forgot", { email: "unknown@example.test" });
  assertStatus(unknownRecovery, 200);
  assert.equal(unknownRecovery.data.message, "If an account exists for that email, a password reset link has been sent.");
  assert.equal(sentEmail, null);
  const recovery = await user.post("/api/password/forgot", { email: "member@example.test" });
  assertStatus(recovery, 200);
  assert.ok(sentEmail);
  const resetUrl = sentEmail.html.match(/href="([^"]+)"/)[1];
  const resetToken = new URL(resetUrl).searchParams.get("token");
  assert.ok(resetToken);
  const recoveredUser = new ApiClient(baseUrl);
  assertStatus(await recoveredUser.post("/api/password/reset", { token: resetToken, password: "member-password-new-456" }), 200);
  assertStatus(await recoveredUser.post("/api/password/reset", { token: resetToken, password: "member-password-new-789" }), 400);
  assertStatus(await user.get("/api/me"), 401);
  user.cookie = "";
  user.csrfToken = "";
  assertStatus(await user.post("/api/login", { email: "member@example.test", password: "member-password-123" }), 401);
  assertStatus(await user.post("/api/login", { email: "member@example.test", password: "member-password-new-456" }), 200);
  if (postgresMode) {
    const persistedSessions = await db.prepare("SELECT COUNT(*) AS count FROM session_store").get();
    assert.ok(persistedSessions.count > 0, "PostgreSQL session store should persist authenticated sessions.");
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    await appPool.end();
    const serverModule = require.resolve(path.join(projectRoot, "server.js"));
    delete require.cache[serverModule];
    const restarted = require(serverModule);
    app = restarted.app;
    db = restarted.db;
    appPool = restarted.pool;
    initializeDatabase = restarted.initializeDatabase;
    await initializeDatabase();
    server = app.listen(port, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    assertStatus(await user.get("/api/me"), 200, "The authenticated session should remain valid after the web listener restarts.");
    assertStatus(await admin.get("/api/admin/summary"), 200, "The admin session should survive a fresh app instance.");
  }
  const belowMinimum = await user.post("/api/withdrawals", { amountRc: 9999, bankName: "Test Bank", accountNumber: "1234567890", accountName: "Test Member" }, { "Idempotency-Key": "below-minimum-0001" });
  assertStatus(belowMinimum, 400);
  const userAdminAccess = await user.get("/api/admin/summary");
  assertStatus(userAdminAccess, 403);

  const advertiser = new ApiClient(baseUrl);
  assertStatus(await advertiser.post("/api/register", { name: "Advertiser Contact", email: "advertiser@example.test", password: "advertiser-password-123", accountType: "advertiser", businessName: "Example Business" }), 200);
  const profile = await advertiser.get("/api/advertiser/profile");
  assertStatus(profile, 200);
  assert.equal(profile.data.status, "pending_review");
  assertStatus(await advertiser.get("/api/admin/users"), 403);
  assertStatus(await advertiser.post("/api/advertiser/campaigns", { title: "Test video", videoUrl: "https://example.test/video.mp4", rewardRc: 10000, budgetNgn: 10000, durationSeconds: 1 }), 403);

  const advertisers = await admin.get("/api/admin/advertisers");
  assertStatus(advertisers, 200);
  assert.ok(Array.isArray(advertisers.data), "admin advertiser response should be a list");
  const advertiserProfile = advertisers.data.find(item => item.email === "advertiser@example.test");
  assert.ok(advertiserProfile);
  assertStatus(await admin.patch(`/api/admin/advertisers/${advertiserProfile.id}`, { status: "approved" }), 200);
  const createdCampaign = await advertiser.post("/api/advertiser/campaigns", {
    title: "Test funded visibility", description: "A test-only campaign.", videoUrl: "https://example.test/video.mp4",
    destinationUrl: "https://example.test/", rewardRc: 10000, budgetNgn: 10000, durationSeconds: 1, targetCompletions: 5
  });
  assertStatus(createdCampaign, 201);
  assert.equal(createdCampaign.data.rewardBudgetRc, 40000);
  const campaignId = createdCampaign.data.id;
  assertStatus(await admin.patch(`/api/admin/campaigns/${campaignId}`, { approvalStatus: "approved" }), 200);
  const activationBeforeFunding = await admin.patch(`/api/admin/campaigns/${campaignId}`, { status: "active" });
  assertStatus(activationBeforeFunding, 409);
  assertStatus(await advertiser.post(`/api/advertiser/campaigns/${campaignId}/funding`, { amountNgn: 10000, paymentReference: "TEST-TRANSFER-1001" }), 201);
  assertStatus(await advertiser.post(`/api/advertiser/campaigns/${campaignId}/funding`, { amountNgn: 1, paymentReference: "TEST-TRANSFER-1002" }), 409);
  const funding = (await admin.get("/api/admin/fundings")).data.find(item => item.campaign_id === campaignId);
  assert.ok(funding);
  assertStatus(await admin.post(`/api/admin/fundings/${funding.id}/reconcile`, {
    status: "confirmed", actualAmountNgn: 10000, reconciliationReference: "TEST-BANK-REF-1001", verificationNote: "Test fixture deposit independently reconciled."
  }), 200);
  const availableCampaigns = await user.get("/api/campaigns");
  assertStatus(availableCampaigns, 200);
  assert.ok(availableCampaigns.data.some(item => item.id === campaignId));
  const fundedState = (await admin.get("/api/admin/campaigns")).data.find(item => item.id === campaignId);
  assert.equal(fundedState.active, 1);
  assert.equal(fundedState.funding_status, "confirmed");
  assert.equal(fundedState.reward_budget_rc, 40000);
  assert.equal(fundedState.viewer_reward_allocation_kobo, 400000);
  assert.equal(fundedState.platform_allocation_kobo, 500000);
  assert.equal(fundedState.operating_reserve_kobo, 100000);
  const clickRedirect = await fetch(`${baseUrl}/api/campaigns/${campaignId}/visit`, { headers: { Cookie: user.cookie }, redirect: "manual" });
  assert.equal(clickRedirect.status, 302);
  const clickedDestination = new URL(clickRedirect.headers.get("location"));
  assert.equal(clickedDestination.origin, "https://example.test");
  assert.equal(clickedDestination.hash, "");
  assert.equal((await user.post("/api/tracking/events", {})).response.status, 404);
  assert.equal(fs.existsSync(path.join(projectRoot, "public/tracking.js")), false);
  const trackedCampaign = (await advertiser.get("/api/advertiser/campaigns")).data.find(item => item.id === campaignId);
  assert.equal(trackedCampaign.website_clicks, 1);
  assert.equal(trackedCampaign.impressions, 1);
  assert.equal((await admin.get("/api/admin/settings")).data.settings.default_view_reward_rc, 25);

  const watchStart = await user.post(`/api/campaigns/${campaignId}/start`, {});
  assertStatus(watchStart, 200);
  await new Promise(resolve => setTimeout(resolve, 2200));
  const completion = await user.post(`/api/campaigns/${campaignId}/complete`, { token: watchStart.data.token });
  assertStatus(completion, 200);
  assert.equal(completion.data.pendingReview, true);
  let wallet = (await user.get("/api/me")).data;
  assert.equal(wallet.pending_rc, 10000);
  assert.equal(wallet.available_rc, 0);
  const taskReviews = await admin.get("/api/admin/task-reviews");
  const task = taskReviews.data.find(item => item.reward === 10000);
  assert.ok(task);
  assertStatus(await admin.patch(`/api/admin/task-reviews/${task.id}`, { decision: "approved" }), 200);
  wallet = (await user.get("/api/me")).data;
  assert.equal(wallet.pending_rc, 0);
  assert.equal(wallet.available_rc, 10000);
  assertStatus(await user.post(`/api/campaigns/${campaignId}/complete`, { token: watchStart.data.token }), 403);
  assertStatus(await admin.patch(`/api/admin/task-reviews/${task.id}`, { decision: "approved" }), 409);

  // Keep previous endpoint traffic from consuming the API limiter during this isolated concurrency scenario.
  await db.prepare("DELETE FROM rate_limit_hits").run();
  const additionalViewers = [];
  for (let index = 1; index <= 4; index++) {
    const viewer = new ApiClient(baseUrl);
    assertStatus(await viewer.post("/api/register", { name: `Concurrent Viewer ${index}`, email: `concurrent-viewer-${index}@example.test`, password: `concurrent-viewer-password-${index}`, accountType: "user" }), 200);
    additionalViewers.push(viewer);
  }
  const simultaneousStarts = await Promise.all(additionalViewers.map(viewer => viewer.post(`/api/campaigns/${campaignId}/start`, {})));
  assert.equal(simultaneousStarts.filter(result => result.response.status === 200).length, 3);
  assert.equal(simultaneousStarts.filter(result => result.response.status === 409).length, 1);
  await new Promise(resolve => setTimeout(resolve, 2200));
  const successfulStarts = simultaneousStarts.map((result, index) => ({ result, viewer: additionalViewers[index] })).filter(item => item.result.response.status === 200);
  const simultaneousCompletions = await Promise.all(successfulStarts.map(({ result, viewer }) => viewer.post(`/api/campaigns/${campaignId}/complete`, { token: result.data.token })));
  assert.equal(simultaneousCompletions.filter(result => result.response.status === 200).length, 3);
  const exhaustedViewer = additionalViewers[simultaneousStarts.findIndex(result => result.response.status === 409)];
  assertStatus(await exhaustedViewer.post(`/api/campaigns/${campaignId}/start`, {}), 404);
  const pendingCampaignRewards = await admin.get("/api/admin/task-reviews");
  const concurrentTasks = pendingCampaignRewards.data.filter(item => item.campaign_title === "Test funded visibility");
  assert.equal(concurrentTasks.length, 3);
  for (const concurrentTask of concurrentTasks) assertStatus(await admin.patch(`/api/admin/task-reviews/${concurrentTask.id}`, { decision: "approved" }), 200);
  const financialsAfterRewards = await admin.get("/api/admin/financials");
  assertStatus(financialsAfterRewards, 200);
  assert.equal(financialsAfterRewards.data.confirmedFundingKobo, 1000000);
  assert.equal(financialsAfterRewards.data.viewerRewardAllocationKobo, 400000);
  assert.equal(financialsAfterRewards.data.viewerRewardsDistributedKobo, 400000);
  assert.equal(financialsAfterRewards.data.viewerRewardPoolRemainingKobo, 0);
  assert.equal(financialsAfterRewards.data.viewerRewardLiabilityKobo, 400000);
  assert.equal(financialsAfterRewards.data.platformAllocationKobo, 500000);
  assert.equal(financialsAfterRewards.data.operatingReserveKobo, 100000);

  const requestKey = "withdrawal-request-test-0001";
  const withdrawalBody = { amountRc: 10000, bankName: "Test Nigerian Bank", accountNumber: "0123456789", accountName: "Test Member" };
  const firstRequest = await user.post("/api/withdrawals", withdrawalBody, { "Idempotency-Key": requestKey });
  assertStatus(firstRequest, 201);
  assert.equal(firstRequest.data.payoutKobo, 100000);
  const duplicateRequest = await user.post("/api/withdrawals", withdrawalBody, { "Idempotency-Key": requestKey });
  assertStatus(duplicateRequest, 200);
  assert.equal(duplicateRequest.data.duplicate, true);
  wallet = (await user.get("/api/me")).data;
  assert.equal(wallet.available_rc, 0);
  assert.equal((await user.get("/api/withdrawals")).data.reservedRc, 10000);
  let adminWithdrawal = (await admin.get("/api/admin/withdrawals")).data.find(item => item.reference === firstRequest.data.reference);
  assert.equal(adminWithdrawal.destination.accountNumber, "0123456789");
  assert.equal(JSON.stringify((await user.get("/api/withdrawals")).data).includes("0123456789"), false);
  assertStatus(await admin.patch(`/api/admin/withdrawals/${firstRequest.data.id}`, { status: "rejected", reason: "Test rejection returns reserved RC." }), 200);
  wallet = (await user.get("/api/me")).data;
  assert.equal(wallet.available_rc, 10000);
  adminWithdrawal = (await admin.get("/api/admin/withdrawals")).data.find(item => item.id === firstRequest.data.id);
  assert.equal(adminWithdrawal.status, "rejected");

  const secondRequest = await user.post("/api/withdrawals", withdrawalBody, { "Idempotency-Key": "withdrawal-request-test-0002" });
  assertStatus(secondRequest, 201);
  assertStatus(await admin.patch(`/api/admin/withdrawals/${secondRequest.data.id}`, { status: "approved" }), 200);
  assertStatus(await admin.patch(`/api/admin/withdrawals/${secondRequest.data.id}`, { status: "processing", reason: "Test payout reconciliation started." }), 200);
  const paid = await admin.patch(`/api/admin/withdrawals/${secondRequest.data.id}`, { status: "paid", payoutReference: "TEST-PAYOUT-REF-22", payoutEvidence: "Test payment fixture confirmed in the isolated test database." });
  assertStatus(paid, 200);
  const expense = await admin.post("/api/admin/operating-expenses", { category: "hosting", amountNgn: "100.50", reference: "HOST-TEST-01", description: "Test-only hosting expense entry." }, { "Idempotency-Key": "expense-record-test-0001" });
  assertStatus(expense, 201);
  const duplicateExpense = await admin.post("/api/admin/operating-expenses", { category: "hosting", amountNgn: "100.50", reference: "HOST-TEST-01", description: "Duplicate test-only expense entry." }, { "Idempotency-Key": "expense-record-test-0001" });
  assertStatus(duplicateExpense, 200);
  assert.equal(duplicateExpense.data.duplicate, true);
  const finalFinancials = await admin.get("/api/admin/financials");
  assert.equal(finalFinancials.data.pendingWithdrawalsKobo, 0);
  assert.equal(finalFinancials.data.completedWithdrawalsKobo, 100000);
  assert.equal(finalFinancials.data.viewerRewardLiabilityKobo, 300000);
  assert.equal(finalFinancials.data.operatingExpensesKobo, 10050);
  assert.equal(finalFinancials.data.netPlatformRevenueKobo, 589950);
  const userWithdrawals = await user.get("/api/withdrawals");
  assert.equal(userWithdrawals.data.rows.find(item => item.id === secondRequest.data.id).status, "paid");
  const paidAgain = await admin.patch(`/api/admin/withdrawals/${secondRequest.data.id}`, { status: "processing" });
  assertStatus(paidAgain, 409);

  const support = await user.post("/api/support", { category: "reward", subject: "Question about a test reward", message: "Please explain this test reward reference." });
  assertStatus(support, 201);
  const supportRows = await admin.get("/api/admin/support");
  assert.ok(supportRows.data.some(item => item.id === Number(support.data.reference.replace("SUP-", ""))));
  const audit = await admin.get("/api/admin/audit?limit=100");
  assert.ok(audit.data.some(item => item.action === "withdrawal.paid"));
  // Start the campaign-action section with a clean test-only API rate-limit window.
  await db.prepare("DELETE FROM rate_limit_hits").run();
  const actionCampaign = await advertiser.post("/api/advertiser/campaigns", {
    title: "Tracked website action", description: "Test-only tracked engagement campaign.", videoUrl: "https://example.test/action.mp4",
    destinationUrl: "https://example.test/landing", budgetNgn: 10000, durationSeconds: 1,
    targetCompletions: 5, actionType: "website_engagement", actionRewardRc: 15000, maxActionRewards: 2, websiteEngagementSeconds: 2
  });
  assertStatus(actionCampaign, 201);
  assert.equal(actionCampaign.data.webhookSecret, undefined);
  assertStatus(await admin.patch(`/api/admin/campaigns/${actionCampaign.data.id}`, { approvalStatus: "approved" }), 200);
  assert.equal((await admin.get("/api/admin/campaigns")).data.find(item => item.id === actionCampaign.data.id).reward, 25);
  assertStatus(await advertiser.post(`/api/advertiser/campaigns/${actionCampaign.data.id}/funding`, { amountNgn: 10000, paymentReference: "ACTION-TEST-TRANSFER-1" }), 201);
  const actionFunding = (await admin.get("/api/admin/fundings")).data.find(item => item.campaign_id === actionCampaign.data.id);
  assertStatus(await admin.post(`/api/admin/fundings/${actionFunding.id}/reconcile`, {
    status: "confirmed", actualAmountNgn: 10000, reconciliationReference: "ACTION-TEST-BANK-REF-1", verificationNote: "Isolated test deposit fixture."
  }), 200);
  const actionStarts = await Promise.all(additionalViewers.slice(0, 3).map(async viewer => ({ viewer,
    result: await viewer.post(`/api/campaigns/${actionCampaign.data.id}/action-start`, {}) })));
  assert.equal(actionStarts.filter(item => item.result.response.status === 200).length, 2);
  assert.equal(actionStarts.filter(item => item.result.response.status === 409).length, 1);
  const reservedActionSessions = actionStarts.filter(item => item.result.response.status === 200).map(item => ({ viewer: item.viewer, ...item.result.data }));
  assertStatus(await reservedActionSessions[0].viewer.post(`/api/campaigns/${actionCampaign.data.id}/action-cancel`, {
    sessionId: reservedActionSessions[0].sessionId, token: reservedActionSessions[0].token
  }), 200);
  const replacementVisit = await reservedActionSessions[0].viewer.post(`/api/campaigns/${actionCampaign.data.id}/action-start`, {});
  assertStatus(replacementVisit, 200);
  const actionSessions = [{ viewer: reservedActionSessions[0].viewer, ...replacementVisit.data }, reservedActionSessions[1]];
  assert.equal(actionSessions[0].minimumSeconds, 15);
  assert.equal(actionSessions[0].destinationUrl, "https://example.test/landing");
  const tooShortVisit = await actionSessions[0].viewer.post(`/api/campaigns/${actionCampaign.data.id}/action-complete`, {
    sessionId: actionSessions[0].sessionId, token: actionSessions[0].token
  });
  assertStatus(tooShortVisit, 400);
  for (const actionSession of actionSessions) {
    await db.prepare("UPDATE campaign_tracking_sessions SET clicked_at = ? WHERE id = ?").run(Date.now() - 15050, actionSession.sessionId);
  }
  const actionCompletions = await Promise.all(actionSessions.map(actionSession => actionSession.viewer.post(`/api/campaigns/${actionCampaign.data.id}/action-complete`, {
    sessionId: actionSession.sessionId, token: actionSession.token
  })));
  assert.equal(actionCompletions.filter(item => item.response.status === 201).length, 2);
  assert.equal(actionCompletions[0].data.rewardRc, 15000);
  const duplicateActionCompletion = await actionSessions[0].viewer.post(`/api/campaigns/${actionCampaign.data.id}/action-complete`, {
    sessionId: actionSessions[0].sessionId, token: actionSessions[0].token
  });
  assertStatus(duplicateActionCompletion, 200);
  assert.equal(duplicateActionCompletion.data.duplicate, true);
  assert.equal((await actionSessions[0].viewer.get("/api/me")).data.available_rc, 25000);
  const actionReviewRows = await admin.get("/api/admin/action-reviews");
  assert.equal(actionReviewRows.data.length, 0);
  const defaultViewStart = await actionSessions[0].viewer.post(`/api/campaigns/${actionCampaign.data.id}/start`, {});
  assertStatus(defaultViewStart, 200);
  await new Promise(resolve => setTimeout(resolve, 2200));
  assertStatus(await actionSessions[0].viewer.post(`/api/campaigns/${actionCampaign.data.id}/complete`, { token: defaultViewStart.data.token }), 200);
  const defaultViewReviews = await admin.get("/api/admin/task-reviews");
  assertStatus(defaultViewReviews, 200);
  const defaultViewReward = defaultViewReviews.data.find(item => item.campaign_title === "Tracked website action");
  assert.equal(defaultViewReward.reward, 25);
  assertStatus(await admin.patch(`/api/admin/task-reviews/${defaultViewReward.id}`, { decision: "approved" }), 200);
  const actionCampaignMetrics = (await advertiser.get("/api/advertiser/campaigns")).data.find(item => item.id === actionCampaign.data.id);
  assert.equal(actionCampaignMetrics.pending_action_rewards, 0);
  assert.equal(actionCampaignMetrics.approved_action_rewards, 2);
  assert.equal(actionCampaignMetrics.committed_rc, 30025);
  const financialsWithActions = await admin.get("/api/admin/financials");
  assert.equal(financialsWithActions.data.viewerRewardPoolRemainingKobo, 99750);
  assert.equal(financialsWithActions.data.viewerRewardsDistributedKobo, 700250);
  assert.equal((await actionSessions[0].viewer.get("/api/transactions")).data.filter(item => item.reward_kind === "action" && item.status === "credited").length, 1);
  const registrationCampaign = await advertiser.post("/api/advertiser/campaigns", {
    title: "Confirmed registration reward", videoUrl: "https://example.test/registration.mp4", destinationUrl: "https://example.test/register",
    budgetNgn: 10000, durationSeconds: 1, actionType: "registration", actionRewardRc: 500, maxActionRewards: 1
  });
  assertStatus(registrationCampaign, 201);
  assertStatus(await admin.patch(`/api/admin/campaigns/${registrationCampaign.data.id}`, { approvalStatus: "approved" }), 200);
  assertStatus(await advertiser.post(`/api/advertiser/campaigns/${registrationCampaign.data.id}/funding`, { amountNgn: 10000, paymentReference: "REGISTRATION-TEST-TRANSFER-1" }), 201);
  const registrationFunding = (await admin.get("/api/admin/fundings")).data.find(item => item.campaign_id === registrationCampaign.data.id);
  assertStatus(await admin.post(`/api/admin/fundings/${registrationFunding.id}/reconcile`, {
    status: "confirmed", actualAmountNgn: 10000, reconciliationReference: "REGISTRATION-TEST-BANK-REF-1", verificationNote: "Isolated registration test fixture."
  }), 200);
  const registrationStart = await additionalViewers[3].post(`/api/campaigns/${registrationCampaign.data.id}/action-start`, {});
  assertStatus(registrationStart, 200);
  const registrationBalanceBefore = (await additionalViewers[3].get("/api/me")).data.available_rc;
  await db.prepare("UPDATE campaign_tracking_sessions SET clicked_at = ? WHERE id = ?").run(Date.now() - 15050, registrationStart.data.sessionId);
  const registrationComplete = await additionalViewers[3].post(`/api/campaigns/${registrationCampaign.data.id}/action-complete`, {
    sessionId: registrationStart.data.sessionId, token: registrationStart.data.token
  });
  assertStatus(registrationComplete, 201);
  assert.equal((await additionalViewers[3].get("/api/me")).data.available_rc, registrationBalanceBefore + 500);
  const updateSettings = await admin.patch("/api/admin/settings", { settings: { coin_rate_rc: 500, coin_rate_kobo: 5000 } });
  assertStatus(updateSettings, 200);
  const duplicateAdminAction = await admin.patch(`/api/admin/withdrawals/${secondRequest.data.id}`, { status: "paid", payoutReference: "ANOTHER", payoutEvidence: "Second payment evidence must not be accepted." });
  assertStatus(duplicateAdminAction, 409);

  await db.prepare("DELETE FROM rate_limit_hits").run();
  const rateLimitClient = new ApiClient(baseUrl);
  for (let attempt = 0; attempt < 10; attempt++) {
    assertStatus(await rateLimitClient.post("/api/login", { email: "missing-rate-limit-user@example.test", password: "invalid-test-password" }), 401);
  }
  assertStatus(await rateLimitClient.post("/api/login", { email: "missing-rate-limit-user@example.test", password: "invalid-test-password" }), 429);
});
