const test = require("node:test");
const assert = require("node:assert/strict");
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
createLegacyDatabase(databasePath);
const { app, db } = require(path.join(projectRoot, "server.js"));

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
    const response = await fetch(this.baseUrl + route, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    global.fetch = originalFetch;
    if (originalResendKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalResendKey;
    if (originalEmailFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = originalEmailFrom;
    if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = originalAppBaseUrl;
    await new Promise(resolve => server.close(resolve));
    db.close();
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
  const advertiserProfile = advertisers.data.find(item => item.email === "advertiser@example.test");
  assert.ok(advertiserProfile);
  assertStatus(await admin.patch(`/api/admin/advertisers/${advertiserProfile.id}`, { status: "approved" }), 200);
  const createdCampaign = await advertiser.post("/api/advertiser/campaigns", {
    title: "Test funded visibility", description: "A test-only campaign.", videoUrl: "https://example.test/video.mp4",
    destinationUrl: "https://example.test/", rewardRc: 10000, budgetNgn: 10000, durationSeconds: 1, targetCompletions: 5
  });
  assertStatus(createdCampaign, 201);
  assert.equal(createdCampaign.data.rewardBudgetRc, 50000);
  const campaignId = createdCampaign.data.id;
  assertStatus(await admin.patch(`/api/admin/campaigns/${campaignId}`, { approvalStatus: "approved" }), 200);
  const activationBeforeFunding = await admin.patch(`/api/admin/campaigns/${campaignId}`, { status: "active" });
  assertStatus(activationBeforeFunding, 409);
  assertStatus(await advertiser.post(`/api/advertiser/campaigns/${campaignId}/funding`, { amountNgn: 10000, paymentReference: "TEST-TRANSFER-1001" }), 201);
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
  const updateSettings = await admin.patch("/api/admin/settings", { settings: { coin_rate_rc: 500, coin_rate_kobo: 5000 } });
  assertStatus(updateSettings, 200);
  const duplicateAdminAction = await admin.patch(`/api/admin/withdrawals/${secondRequest.data.id}`, { status: "paid", payoutReference: "ANOTHER", payoutEvidence: "Second payment evidence must not be accepted." });
  assertStatus(duplicateAdminAction, 409);
});
