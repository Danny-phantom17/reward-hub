const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcryptjs");
let BetterDatabase;
try {
  BetterDatabase = require("better-sqlite3");
} catch (error) {
  if (!String(error.message).includes("Could not locate the bindings file")) throw error;
}
class BuiltinSqliteDatabase {
  constructor(filename) {
    const { DatabaseSync } = require("node:sqlite");
    this.native = new DatabaseSync(filename);
  }
  exec(sql) { return this.native.exec(sql); }
  close() { return this.native.close(); }
  pragma(setting) { return this.native.exec(`PRAGMA ${setting}`); }
  prepare(sql) {
    const statement = this.native.prepare(sql);
    return {
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
      run: (...params) => {
        const result = statement.run(...params);
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
      }
    };
  }
  transaction(work) {
    const execute = mode => (...args) => {
      this.native.exec(`BEGIN${mode ? ` ${mode}` : ""}`);
      try {
        const result = work(...args);
        this.native.exec("COMMIT");
        return result;
      } catch (error) {
        this.native.exec("ROLLBACK");
        throw error;
      }
    };
    const run = execute("");
    run.immediate = execute("IMMEDIATE");
    return run;
  }
}
const Database = BetterDatabase
  ? class CompatibleDatabase {
      constructor(filename) {
        try { return new BetterDatabase(filename); }
        catch (error) {
          if (!String(error.message).includes("Could not locate the bindings file")) throw error;
          return new BuiltinSqliteDatabase(filename);
        }
      }
    }
  : BuiltinSqliteDatabase;
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, "rewardhub.db"));
const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET;
const WATCH_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

if (isProduction && (!sessionSecret || sessionSecret.length < 32)) {
  throw new Error("SESSION_SECRET must be set to at least 32 characters in production.");
}

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS advertiser_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending_review',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS app_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER,
  entry_type TEXT NOT NULL,
  amount_rc INTEGER NOT NULL DEFAULT 0,
  amount_kobo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted',
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  actor_user_id INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(actor_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(actor_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  advertiser TEXT NOT NULL,
  description TEXT DEFAULT '',
  video_url TEXT NOT NULL,
  destination_url TEXT DEFAULT '',
  reward INTEGER NOT NULL DEFAULT 10,
  duration_seconds INTEGER NOT NULL DEFAULT 5,
  budget INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  reward INTEGER NOT NULL,
  watched_seconds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, campaign_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  account_details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS campaign_fundings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  amount_kobo INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  provider TEXT NOT NULL DEFAULT 'manual',
  advertiser_reference TEXT NOT NULL DEFAULT '',
  reconciliation_reference TEXT NOT NULL DEFAULT '',
  submitted_by INTEGER NOT NULL,
  confirmed_by INTEGER,
  verification_note TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY(submitted_by) REFERENCES users(id),
  FOREIGN KEY(confirmed_by) REFERENCES users(id),
  UNIQUE(provider, reconciliation_reference)
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  admin_response TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(resolved_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS watch_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  required_seconds INTEGER NOT NULL,
  reserved_reward INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS session_store (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  bucket TEXT NOT NULL,
  hit_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits ON rate_limit_hits(bucket, hit_at);
`);

const watchSessionColumns = db.prepare("PRAGMA table_info(watch_sessions)").all().map(column => column.name);
if (!watchSessionColumns.includes("required_seconds")) db.exec("ALTER TABLE watch_sessions ADD COLUMN required_seconds INTEGER NOT NULL DEFAULT 1");
if (!watchSessionColumns.includes("reserved_reward")) db.exec("ALTER TABLE watch_sessions ADD COLUMN reserved_reward INTEGER NOT NULL DEFAULT 0");
function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
ensureColumn("users", "available_rc", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "pending_rc", "INTEGER NOT NULL DEFAULT 0");
const userColumnsBeforeLegacy = db.prepare("PRAGMA table_info(users)").all().map(column => column.name);
if (!userColumnsBeforeLegacy.includes("legacy_balance_kobo")) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE users ADD COLUMN legacy_balance_kobo INTEGER NOT NULL DEFAULT 0;
    UPDATE users SET legacy_balance_kobo = balance * 100 WHERE balance > 0;
    UPDATE users SET balance = 0 WHERE balance > 0;
    INSERT INTO ledger_entries (reference, user_id, entry_type, amount_kobo, status, entity_type, entity_id, idempotency_key, description)
    SELECT 'LEGACY-' || id, id, 'legacy_balance_held', legacy_balance_kobo, 'reconciliation_required', 'user', id,
      'legacy-balance-' || id, 'Legacy balance held for reconciliation; not withdrawable.'
    FROM users WHERE legacy_balance_kobo > 0
    ON CONFLICT(idempotency_key) DO NOTHING;
    COMMIT;
  `);
}

ensureColumn("campaigns", "duration_seconds", "INTEGER NOT NULL DEFAULT 5");
ensureColumn("campaigns", "status", "TEXT NOT NULL DEFAULT 'active'");
ensureColumn("campaigns", "advertiser_user_id", "INTEGER REFERENCES users(id)");
ensureColumn("campaigns", "objective", "TEXT NOT NULL DEFAULT 'video_visibility'");
ensureColumn("campaigns", "qualifying_rules", "TEXT NOT NULL DEFAULT 'Watch for at least 90% of the advertised video duration. Reward is pending until administrator review.'");
ensureColumn("campaigns", "approval_status", "TEXT NOT NULL DEFAULT 'pending_review'");
ensureColumn("campaigns", "funding_status", "TEXT NOT NULL DEFAULT 'unfunded'");
ensureColumn("campaigns", "advertiser_budget_kobo", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("campaigns", "funded_kobo", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("campaigns", "reward_budget_rc", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("campaigns", "reward_allocation_bps", "INTEGER NOT NULL DEFAULT 5000");
ensureColumn("campaigns", "reward_rate_rc", "INTEGER NOT NULL DEFAULT 1000");
ensureColumn("campaigns", "reward_rate_kobo", "INTEGER NOT NULL DEFAULT 10000");
ensureColumn("campaigns", "target_completions", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("campaigns", "review_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("campaigns", "reviewed_by", "INTEGER REFERENCES users(id)");
ensureColumn("campaigns", "reviewed_at", "TEXT");
ensureColumn("campaigns", "expires_at", "TEXT");
ensureColumn("views", "attempt_reference", "TEXT NOT NULL DEFAULT ''");
ensureColumn("views", "rejection_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("views", "reviewed_by", "INTEGER REFERENCES users(id)");
ensureColumn("views", "reviewed_at", "TEXT");
ensureColumn("withdrawals", "request_reference", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "amount_rc", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("withdrawals", "gross_kobo", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("withdrawals", "fee_kobo", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("withdrawals", "payout_kobo", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("withdrawals", "bank_name", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "destination_encrypted", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "account_last4", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "account_name", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "rate_rc", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("withdrawals", "rate_kobo", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("withdrawals", "idempotency_key", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "rejection_reason", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "payout_reference", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "payout_evidence", "TEXT NOT NULL DEFAULT ''");
ensureColumn("withdrawals", "reviewed_by", "INTEGER REFERENCES users(id)");
ensureColumn("withdrawals", "reviewed_at", "TEXT");
ensureColumn("withdrawals", "processing_at", "TEXT");
ensureColumn("withdrawals", "paid_at", "TEXT");
ensureColumn("withdrawals", "paid_by", "INTEGER REFERENCES users(id)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawal_reference ON withdrawals(request_reference) WHERE request_reference <> ''");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawal_idempotency ON withdrawals(user_id, idempotency_key) WHERE idempotency_key <> ''");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_view_attempt_reference ON views(attempt_reference) WHERE attempt_reference <> ''");
db.exec("CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger_entries(user_id, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_campaign_funding_status ON campaign_fundings(status, created_at)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_submitted_reference ON campaign_fundings(submitted_by, advertiser_reference) WHERE advertiser_reference <> ''");
db.exec("UPDATE campaigns SET status = CASE WHEN active = 1 THEN 'active' ELSE 'paused' END WHERE status IS NULL OR status = '' OR status = 'active'");
db.exec("UPDATE campaigns SET active = 0, status = CASE WHEN status IN ('active','paused') THEN 'draft' ELSE status END WHERE funding_status <> 'confirmed' OR approval_status <> 'approved'");
db.exec("UPDATE views SET status = 'legacy_review' WHERE status = 'completed'");
db.exec("UPDATE withdrawals SET status = 'legacy_review' WHERE amount_rc = 0 AND status IN ('pending','approved')");
const defaultSettings = [
  ["coin_rate_rc", "10000"], ["coin_rate_kobo", "100000"], ["minimum_withdrawal_rc", "20000"],
  ["withdrawal_fee_kobo", "0"], ["reward_allocation_bps", "5000"], ["variable_cost_bps", "2000"]
];
const addSetting = db.prepare("INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING");
for (const [key, value] of defaultSettings) addSetting.run(key, value);

const coinRateMigration = "coin-rate-10k-rc-per-1000-ngn-v1";
if (!db.prepare("SELECT 1 FROM app_migrations WHERE name = ?").get(coinRateMigration)) {
  db.transaction(() => {
    const oldRate = db.prepare("SELECT key, value FROM platform_settings WHERE key IN ('coin_rate_rc','coin_rate_kobo')").all();
    const oldRateValues = Object.fromEntries(oldRate.map(row => [row.key, row.value]));
    if (oldRateValues.coin_rate_rc === "1000" && oldRateValues.coin_rate_kobo === "10000") {
      db.prepare("UPDATE platform_settings SET value = CASE key WHEN 'coin_rate_rc' THEN '10000' WHEN 'coin_rate_kobo' THEN '100000' END WHERE key IN ('coin_rate_rc','coin_rate_kobo')").run();
    }
    db.prepare("UPDATE platform_settings SET value = '20000' WHERE key = 'minimum_withdrawal_rc' AND value = '10000'").run();
    db.prepare("INSERT INTO app_migrations(name) VALUES (?)").run(coinRateMigration);
  }).immediate();
}

const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;

if (isProduction && (!adminEmail || !adminPassword || adminPassword.length < 12)) {
  throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters in production.");
}

if (adminEmail && adminPassword && !db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail.trim().toLowerCase())) {
  const hash = bcrypt.hashSync(adminPassword, 10);
  db.prepare(`
    INSERT INTO users (name, email, password_hash, role)
    VALUES (?, ?, ?, 'admin')
  `).run("Administrator", adminEmail, hash);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (isProduction) app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

class SqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.cleanupTimer = setInterval(() => {
      this.db.prepare("DELETE FROM session_store WHERE expires <= ?").run(Date.now());
    }, 15 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare("SELECT sess, expires FROM session_store WHERE sid = ?").get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        this.destroy(sid, error => callback(error, null));
        return;
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.db.prepare(`
        INSERT INTO session_store (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
      `).run(sid, JSON.stringify(sess), expires);
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 24 * 60 * 60 * 1000;
      this.db.prepare("UPDATE session_store SET expires = ? WHERE sid = ?").run(expires, sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare("DELETE FROM session_store WHERE sid = ?").run(sid);
      callback(null);
    } catch (error) { callback(error); }
  }
}

app.use(session({
  secret: sessionSecret || crypto.randomBytes(32).toString("hex"),
  store: new SqliteSessionStore(db),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

function rateLimitWindow({ windowMs, limit, key }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucket = key(req);
    const allowed = db.transaction(() => {
      db.prepare("DELETE FROM rate_limit_hits WHERE hit_at <= ?").run(now - windowMs);
      const count = db.prepare("SELECT COUNT(*) AS count FROM rate_limit_hits WHERE bucket = ? AND hit_at > ?").get(bucket, now - windowMs).count;
      if (count >= limit) return false;
      db.prepare("INSERT INTO rate_limit_hits (bucket, hit_at) VALUES (?, ?)").run(bucket, now);
      return true;
    }).immediate();
    if (!allowed) return res.status(429).json({ error: "Too many requests. Wait and try again." });
    next();
  };
}
app.use("/api", rateLimitWindow({ windowMs: 60 * 1000, limit: 120, key: req => `api:${req.ip}` }));
app.use(["/api/login", "/api/register"], rateLimitWindow({ windowMs: 15 * 60 * 1000, limit: 10, key: req => `auth:${req.ip}` }));
app.use(["/api/password/forgot", "/api/password/reset"], rateLimitWindow({ windowMs: 15 * 60 * 1000, limit: 5, key: req => `password:${req.ip}` }));

app.get("/api/csrf", (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.json({ csrfToken: req.session.csrfToken });
});
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const expected = req.session.csrfToken;
  const supplied = req.get("x-csrf-token");
  if (!expected || !supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
    return res.status(403).json({ error: "Invalid or missing security token. Refresh the page and try again." });
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Authentication required." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

function requireAdvertiser(req, res, next) {
  if (!req.session.user || req.session.user.role !== "advertiser") {
    return res.status(403).json({ error: "Advertiser access required." });
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.session.user || req.session.user.role !== "user") {
    return res.status(403).json({ error: "User account access required." });
  }
  next();
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
  return row ? Number(row.value) : 0;
}

function publicSettings() {
  return {
    coinRateRc: getSetting("coin_rate_rc"),
    coinRateKobo: getSetting("coin_rate_kobo"),
    minimumWithdrawalRc: getSetting("minimum_withdrawal_rc"),
    withdrawalFeeKobo: getSetting("withdrawal_fee_kobo"),
    rewardAllocationBps: getSetting("reward_allocation_bps"),
    variableCostBps: getSetting("variable_cost_bps"),
    fundingConfigured: Boolean(process.env.ADVERTISER_FUNDING_INSTRUCTIONS),
    bankPayoutConfigured: Boolean(process.env.BANK_DETAILS_ENCRYPTION_KEY),
    manualPayouts: true
  };
}

function convertRcToKobo(amountRc, rateRc = getSetting("coin_rate_rc"), rateKobo = getSetting("coin_rate_kobo")) {
  if (!Number.isSafeInteger(amountRc) || amountRc < 0 || !Number.isSafeInteger(rateRc) || rateRc <= 0 || !Number.isSafeInteger(rateKobo) || rateKobo <= 0) return null;
  const result = (BigInt(amountRc) * BigInt(rateKobo)) / BigInt(rateRc);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function formatNaira(kobo) {
  const naira = Math.floor(Number(kobo || 0) / 100);
  return `₦${naira.toLocaleString("en-NG")}`;
}

function writeLedger({ userId = null, type, amountRc = 0, amountKobo = 0, status = "posted", entityType = "", entityId = null, idempotencyKey, description = "", actorUserId = null, metadata = {} }) {
  return db.prepare(`
    INSERT INTO ledger_entries
    (reference, user_id, entry_type, amount_rc, amount_kobo, status, entity_type, entity_id, idempotency_key, description, actor_user_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`LDG-${crypto.randomBytes(8).toString("hex").toUpperCase()}`, userId, type, amountRc, amountKobo, status,
    entityType, entityId, idempotencyKey, description.slice(0, 500), actorUserId, JSON.stringify(metadata));
}

function writeAudit(actorUserId, action, entityType, entityId, details = {}) {
  db.prepare("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)")
    .run(actorUserId || null, action, entityType, entityId || null, JSON.stringify(details));
}

function notify(userId, type, title, message, entityType = "", entityId = null) {
  db.prepare("INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, type, title, message, entityType, entityId);
}

function encryptionKey() {
  const configured = process.env.BANK_DETAILS_ENCRYPTION_KEY;
  return configured ? crypto.createHash("sha256").update(configured).digest() : null;
}

function encryptBankDetails(details) {
  const key = encryptionKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(details), "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}

function decryptBankDetails(value) {
  const key = encryptionKey();
  if (!key || !value) return null;
  const [iv, tag, body] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "hex")), decipher.final()]).toString("utf8"));
}

function maskAccountNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `•••• ${digits.slice(-4)}` : "Not provided";
}

app.get("/api/public/settings", (req, res) => res.json(publicSettings()));

app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  const accountType = req.body.accountType === "advertiser" ? "advertiser" : "user";
  const businessName = typeof req.body.businessName === "string" ? req.body.businessName.trim() : "";
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100 ||
      typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      typeof password !== "string" || password.length < 12 || password.length > 200 ||
      (accountType === "advertiser" && (!businessName || businessName.length > 150))) {
    return res.status(400).json({ error: "Enter a name, valid email, password with at least 12 characters, and a business name for advertiser accounts." });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.transaction(() => {
      const created = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
        .run(name.trim(), email.trim().toLowerCase(), hash, accountType);
      if (accountType === "advertiser") {
        const website = typeof req.body.website === "string" ? req.body.website.trim() : "";
        if (website) {
          let validWebsite = false;
          try { validWebsite = ["http:", "https:"].includes(new URL(website).protocol); } catch {}
          if (!validWebsite || website.length > 500) throw new Error("INVALID_ADVERTISER_WEBSITE");
        }
        db.prepare("INSERT INTO advertiser_profiles (user_id, business_name, website) VALUES (?, ?, ?)").run(created.lastInsertRowid, businessName, website);
      }
      return created;
    }).immediate();

    req.session.regenerate(error => {
      if (error) return res.status(500).json({ error: "Unable to start a secure session." });
      req.session.user = { id: result.lastInsertRowid, name: name.trim(), email: email.trim().toLowerCase(), role: accountType };
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      req.session.save(saveError => saveError ? res.status(500).json({ error: "Unable to save session." }) : res.json({ ok: true, role: accountType }));
    });
  } catch (error) {
    if (error.message === "INVALID_ADVERTISER_WEBSITE") return res.status(400).json({ error: "Enter a valid HTTP or HTTPS business website." });
    res.status(400).json({ error: "That email is already registered." });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Email and password are required." });
  }
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  req.session.regenerate(error => {
    if (error) return res.status(500).json({ error: "Unable to start a secure session." });
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    req.session.save(saveError => saveError ? res.status(500).json({ error: "Unable to save session." }) : res.json({ ok: true, role: user.role }));
  });
});

function passwordResetConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.APP_BASE_URL);
}

async function sendPasswordResetEmail(email, token) {
  const baseUrl = process.env.APP_BASE_URL.replace(/\/$/, "");
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [email],
      subject: "Reset your RewardHub password",
      html: `<p>We received a request to reset your RewardHub password.</p><p><a href="${resetUrl}">Choose a new password</a></p><p>This link expires in 30 minutes. If you did not request this, you can ignore this email.</p>`
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Password reset email delivery failed (${response.status}).`);
}

app.post("/api/password/forgot", async (req, res) => {
  if (!passwordResetConfigured()) return res.status(503).json({ error: "Password recovery email is not configured yet." });
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  const user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);
  if (user) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    db.transaction(() => {
      db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at <= ?").run(user.id, now);
      db.prepare("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(user.id, tokenHash, now + 30 * 60 * 1000, now);
    }).immediate();
    try {
      await sendPasswordResetEmail(user.email, token);
    } catch (error) {
      db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash);
      console.error("Password reset email could not be delivered.", error.message);
      return res.status(503).json({ error: "We could not send the recovery email right now. Try again later." });
    }
  }
  res.json({ ok: true, message: "If an account exists for that email, a password reset link has been sent." });
});

app.post("/api/password/reset", async (req, res) => {
  const token = typeof req.body.token === "string" ? req.body.token : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (password.length < 12 || password.length > 200) return res.status(400).json({ error: "Use a password between 12 and 200 characters." });
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const passwordHash = await bcrypt.hash(password, 12);
  const changed = db.transaction(() => {
    const reset = db.prepare("SELECT id, user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(tokenHash, Date.now());
    if (!reset) return false;
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, reset.user_id);
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(Date.now(), reset.user_id);
    db.prepare("DELETE FROM session_store WHERE json_extract(sess, '$.user.id') = ?").run(reset.user_id);
    writeAudit(null, "account.password_reset", "user", reset.user_id, {});
    return true;
  }).immediate();
  if (!changed) return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
  res.json({ ok: true, message: "Password updated. Sign in with your new password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, name, email, role, available_rc, pending_rc, legacy_balance_kobo, created_at FROM users WHERE id = ?")
    .get(req.session.user.id);
  if (user.role === "advertiser") {
    user.advertiser = db.prepare("SELECT business_name, status FROM advertiser_profiles WHERE user_id = ?").get(user.id) || null;
  }
  user.settings = publicSettings();
  res.json(user);
});

app.get("/api/campaigns", requireUser, (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*,
      CASE WHEN v.id IS NULL THEN 0 ELSE 1 END AS completed,
      v.status AS completion_status,
      COALESCE((SELECT SUM(v2.reward) FROM views v2 WHERE v2.campaign_id = c.id AND v2.status IN ('pending','approved')), 0) AS committed_rc
    FROM campaigns c
    LEFT JOIN views v ON v.campaign_id = c.id AND v.user_id = ?
    WHERE c.active = 1 AND c.approval_status = 'approved' AND c.funding_status = 'confirmed'
      AND c.funded_kobo >= c.advertiser_budget_kobo
      AND c.reward_budget_rc > COALESCE((SELECT SUM(v3.reward) FROM views v3 WHERE v3.campaign_id = c.id AND v3.status IN ('pending','approved')), 0)
      AND (c.target_completions = 0 OR c.target_completions > (SELECT COUNT(*) FROM views vt WHERE vt.campaign_id = c.id AND vt.status IN ('pending','approved')))
    ORDER BY c.id DESC
  `).all(req.session.user.id);
  res.json(campaigns);
});

app.get("/api/campaigns/:id", requireUser, (req, res) => {
  const campaign = db.prepare(`
    SELECT c.*,
      CASE WHEN v.id IS NULL THEN 0 ELSE 1 END AS completed
    FROM campaigns c
    LEFT JOIN views v ON v.campaign_id = c.id AND v.user_id = ?
    WHERE c.id = ? AND c.active = 1 AND c.approval_status = 'approved' AND c.funding_status = 'confirmed'
      AND c.funded_kobo >= c.advertiser_budget_kobo
      AND c.reward_budget_rc > COALESCE((SELECT SUM(v2.reward) FROM views v2 WHERE v2.campaign_id = c.id AND v2.status IN ('pending','approved')), 0)
      AND (c.target_completions = 0 OR c.target_completions > (SELECT COUNT(*) FROM views vt WHERE vt.campaign_id = c.id AND vt.status IN ('pending','approved')))
  `).get(req.session.user.id, req.params.id);

  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  if (!campaign.active || campaign.reward <= 0 || campaign.reward_budget_rc < campaign.reward) {
    return res.status(409).json({ error: "This campaign is not currently available." });
  }
  res.json(campaign);
});

app.post("/api/campaigns/:id/start", requireUser, (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND active = 1 AND approval_status = 'approved' AND funding_status = 'confirmed' AND funded_kobo >= advertiser_budget_kobo").get(req.params.id);
  if (!campaign || campaign.reward <= 0) return res.status(404).json({ error: "Campaign not found or not available." });
  if (db.prepare("SELECT 1 FROM views WHERE user_id = ? AND campaign_id = ?").get(req.session.user.id, campaign.id)) {
    return res.status(409).json({ error: "You already completed this campaign." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const requiredSeconds = Math.max(2, Math.ceil(campaign.duration_seconds * 0.9));
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM watch_sessions WHERE started_at < ?").run(Date.now() - WATCH_SESSION_TTL_MS);
      db.prepare("DELETE FROM watch_sessions WHERE user_id = ? AND campaign_id = ?").run(req.session.user.id, campaign.id);
      const current = db.prepare(`
        SELECT c.reward_budget_rc AS budget, c.reward, c.target_completions,
          COALESCE((SELECT SUM(v.reward) FROM views v WHERE v.campaign_id = c.id AND v.status IN ('pending','approved')), 0) AS spent,
          COALESCE((SELECT SUM(ws.reserved_reward) FROM watch_sessions ws WHERE ws.campaign_id = c.id), 0) AS reserved,
          (SELECT COUNT(*) FROM views v WHERE v.campaign_id = c.id AND v.status IN ('pending','approved')) AS committed_count,
          (SELECT COUNT(*) FROM watch_sessions ws WHERE ws.campaign_id = c.id) AS reserved_count
        FROM campaigns c WHERE c.id = ? AND c.active = 1 AND c.approval_status = 'approved' AND c.funding_status = 'confirmed' AND c.funded_kobo >= c.advertiser_budget_kobo
      `).get(campaign.id);
      if (!current || current.spent + current.reserved + current.reward > current.budget) throw new Error("CAMPAIGN_BUDGET_RESERVED");
      if (current.target_completions > 0 && current.committed_count + current.reserved_count >= current.target_completions) throw new Error("CAMPAIGN_TARGET_RESERVED");
      db.prepare("INSERT INTO watch_sessions (token, user_id, campaign_id, started_at, required_seconds, reserved_reward) VALUES (?, ?, ?, ?, ?, ?)")
        .run(token, req.session.user.id, campaign.id, Date.now(), requiredSeconds, current.reward);
    }).immediate();
  } catch (error) {
    if (error.message === "CAMPAIGN_BUDGET_RESERVED") return res.status(409).json({ error: "Campaign budget is exhausted." });
    if (error.message === "CAMPAIGN_TARGET_RESERVED") return res.status(409).json({ error: "This campaign has reached its target while existing completions are under review." });
    throw error;
  }
  res.json({ token, minimumWatchSeconds: requiredSeconds });
});

app.post("/api/campaigns/:id/complete", requireAuth, (req, res) => {
  const token = typeof req.body.token === "string" ? req.body.token : "";
  const campaignId = Number(req.params.id);
  const watchSession = db.prepare(`
    SELECT * FROM watch_sessions WHERE token = ? AND user_id = ? AND campaign_id = ?
  `).get(token, req.session.user.id, campaignId);
  if (!watchSession) return res.status(403).json({ error: "Start the campaign before claiming its reward." });
  const campaign = db.prepare(`
    SELECT c.*,
      COALESCE((SELECT SUM(v.reward) FROM views v WHERE v.campaign_id = c.id), 0) AS spent,
      COALESCE((SELECT SUM(ws.reserved_reward) FROM watch_sessions ws WHERE ws.campaign_id = c.id), 0) AS reserved
    FROM campaigns c WHERE c.id = ? AND c.active = 1
  `).get(campaignId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const elapsedSeconds = Math.floor((Date.now() - watchSession.started_at) / 1000);
  if (elapsedSeconds > WATCH_SESSION_TTL_MS / 1000) {
    db.prepare("DELETE FROM watch_sessions WHERE token = ?").run(token);
    return res.status(410).json({ error: "This campaign session expired. Start it again." });
  }
  if (elapsedSeconds < watchSession.required_seconds) return res.status(400).json({ error: "Please watch the campaign before completing it." });

  const transaction = db.transaction(() => {
    const freshSession = db.prepare("SELECT * FROM watch_sessions WHERE token = ? AND user_id = ? AND campaign_id = ?")
      .get(token, req.session.user.id, campaignId);
    if (!freshSession) throw new Error("WATCH_SESSION_CONSUMED");
    const freshCampaign = db.prepare(`
      SELECT c.*,
        COALESCE((SELECT SUM(v.reward) FROM views v WHERE v.campaign_id = c.id AND v.status IN ('pending','approved')), 0) AS spent,
        COALESCE((SELECT SUM(ws.reserved_reward) FROM watch_sessions ws WHERE ws.campaign_id = c.id), 0) AS reserved
      FROM campaigns c WHERE c.id = ? AND c.active = 1 AND c.approval_status = 'approved' AND c.funding_status = 'confirmed' AND c.funded_kobo >= c.advertiser_budget_kobo
    `).get(campaignId);
    if (!freshCampaign || freshCampaign.spent + freshCampaign.reserved > freshCampaign.reward_budget_rc) throw new Error("CAMPAIGN_BUDGET_EXHAUSTED");
    const view = db.prepare(`
      INSERT INTO views (user_id, campaign_id, reward, watched_seconds)
      VALUES (?, ?, ?, ?)
    `).run(req.session.user.id, campaignId, freshSession.reserved_reward, elapsedSeconds);
    db.prepare("UPDATE views SET status = 'pending', attempt_reference = ? WHERE id = ?")
      .run(`TASK-${crypto.randomBytes(8).toString("hex").toUpperCase()}`, view.lastInsertRowid);
    const changed = db.prepare("UPDATE users SET pending_rc = pending_rc + ? WHERE id = ?")
      .run(freshSession.reserved_reward, req.session.user.id).changes;
    if (!changed) throw new Error("USER_NOT_FOUND");
    writeLedger({ userId: req.session.user.id, type: "task_reward_pending", amountRc: freshSession.reserved_reward, status: "pending",
      entityType: "view", entityId: view.lastInsertRowid, idempotencyKey: `view:${view.lastInsertRowid}:pending`,
      description: "Campaign completion submitted for administrator review." });
    notify(req.session.user.id, "reward_pending", "Reward pending review", `Your ${freshSession.reserved_reward.toLocaleString()} RC task reward is awaiting review.`, "view", view.lastInsertRowid);
    db.prepare("DELETE FROM watch_sessions WHERE token = ?").run(token);
    const totals = db.prepare(`SELECT COALESCE(SUM(reward),0) AS committed_rc, COUNT(*) AS committed_count
      FROM views WHERE campaign_id = ? AND status IN ('pending','approved')`).get(campaignId);
    if (totals.committed_rc >= freshCampaign.reward_budget_rc || (freshCampaign.target_completions > 0 && totals.committed_count >= freshCampaign.target_completions)) {
      db.prepare("UPDATE campaigns SET active = 0, status = 'delivery_paused_pending_review' WHERE id = ?").run(campaignId);
    }
  });

  try { transaction.immediate(); }
  catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "You already completed this campaign." });
    if (error.message === "WATCH_SESSION_CONSUMED") return res.status(409).json({ error: "This campaign session has already been used." });
    if (error.message === "CAMPAIGN_BUDGET_EXHAUSTED") return res.status(409).json({ error: "Campaign budget is exhausted." });
    throw error;
  }
  res.json({ ok: true, pendingReview: true, reward: watchSession.reserved_reward });
});

app.get("/api/transactions", requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT v.id, c.title, CASE WHEN v.status = 'legacy_review' THEN 0 ELSE v.reward END AS amount_rc,
      CASE WHEN v.status = 'legacy_review' THEN v.reward * 100 ELSE 0 END AS legacy_amount_kobo,
      v.status, v.attempt_reference AS reference, v.rejection_reason, v.created_at
    FROM views v
    JOIN campaigns c ON c.id = v.campaign_id
    WHERE v.user_id = ?
    ORDER BY v.id DESC
  `).all(req.session.user.id);
  res.json(rows);
});

app.post("/api/withdrawals", requireUser, (req, res) => {
  const { amountRc, bankName, accountNumber, accountName } = req.body;
  const amount = Number(amountRc);
  const minimum = getSetting("minimum_withdrawal_rc");
  if (!encryptionKey()) return res.status(503).json({ error: "Withdrawals are unavailable until secure bank-detail encryption is configured." });
  if (!Number.isSafeInteger(amount) || amount < minimum) {
    return res.status(400).json({ error: `The minimum withdrawal is ${minimum.toLocaleString()} RC.` });
  }
  if (typeof bankName !== "string" || !bankName.trim() || bankName.trim().length > 100 ||
      typeof accountNumber !== "string" || !/^\d{10}$/.test(accountNumber) ||
      typeof accountName !== "string" || !accountName.trim() || accountName.trim().length > 150) {
    return res.status(400).json({ error: "Enter a bank name, a 10-digit account number, and the account name. Bank ownership is verified manually." });
  }
  const idempotencyKey = req.get("Idempotency-Key") || "";
  if (!/^[A-Za-z0-9-]{16,100}$/.test(idempotencyKey)) return res.status(400).json({ error: "A valid withdrawal request identifier is required. Refresh the form and try again." });
  const rateRc = getSetting("coin_rate_rc");
  const rateKobo = getSetting("coin_rate_kobo");
  const grossKobo = convertRcToKobo(amount, rateRc, rateKobo);
  const feeKobo = getSetting("withdrawal_fee_kobo");
  if (grossKobo === null || !Number.isSafeInteger(feeKobo) || feeKobo < 0 || feeKobo > grossKobo) {
    return res.status(503).json({ error: "Withdrawal conversion settings need administrator review." });
  }
  const destination = encryptBankDetails({ bankName: bankName.trim(), accountNumber, accountName: accountName.trim() });
  const reference = `WD-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;

  try {
    const result = db.transaction(() => {
      const previous = db.prepare("SELECT * FROM withdrawals WHERE user_id = ? AND idempotency_key = ?").get(req.session.user.id, idempotencyKey);
      if (previous) return { withdrawal: previous, duplicate: true };
      const debit = db.prepare("UPDATE users SET available_rc = available_rc - ? WHERE id = ? AND available_rc >= ?")
        .run(amount, req.session.user.id, amount).changes;
      if (!debit) throw new Error("INSUFFICIENT_BALANCE");
      const created = db.prepare(`
        INSERT INTO withdrawals
        (user_id, amount, method, account_details, status, request_reference, amount_rc, gross_kobo, fee_kobo,
          payout_kobo, bank_name, destination_encrypted, account_last4, account_name, rate_rc, rate_kobo, idempotency_key)
    VALUES (?, ?, 'Bank transfer', '[encrypted destination]', 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
      `).run(req.session.user.id, amount, reference, amount, grossKobo, feeKobo, grossKobo - feeKobo,
        bankName.trim(), destination, accountNumber.slice(-4), rateRc, rateKobo, idempotencyKey);
      const id = created.lastInsertRowid;
      writeLedger({ userId: req.session.user.id, type: "withdrawal_reservation", amountRc: -amount, entityType: "withdrawal", entityId: id,
        idempotencyKey: `withdrawal:${id}:reserve`, description: `Withdrawal ${reference} reserved for manual review.` });
      writeAudit(req.session.user.id, "withdrawal.submitted", "withdrawal", id,
        { reference, amountRc: amount, payoutKobo: grossKobo - feeKobo, bankName: bankName.trim(), accountLast4: accountNumber.slice(-4) });
      notify(req.session.user.id, "withdrawal_pending", "Withdrawal request submitted", `${reference} is pending review.`, "withdrawal", id);
      return { withdrawal: db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(id), duplicate: false };
    }).immediate();
    const w = result.withdrawal;
    res.status(result.duplicate ? 200 : 201).json({
      ok: true, duplicate: result.duplicate, id: w.id, reference: w.request_reference, amountRc: w.amount_rc,
      grossKobo: w.gross_kobo, feeKobo: w.fee_kobo, payoutKobo: w.payout_kobo,
      bankName: w.bank_name, accountLast4: w.account_last4, status: w.status, createdAt: w.created_at
    });
  } catch (error) {
    if (error.message === "INSUFFICIENT_BALANCE") return res.status(400).json({ error: "Your available RC balance is no longer sufficient for this request." });
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      const existing = db.prepare("SELECT * FROM withdrawals WHERE user_id = ? AND idempotency_key = ?").get(req.session.user.id, idempotencyKey);
      if (existing) return res.json({ ok: true, duplicate: true, id: existing.id, reference: existing.request_reference, amountRc: existing.amount_rc, status: existing.status });
    }
    throw error;
  }
});

app.get("/api/withdrawals", requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT id, request_reference AS reference, amount_rc, gross_kobo, fee_kobo, payout_kobo,
      bank_name, account_last4, status, rejection_reason, payout_reference, created_at, reviewed_at, processing_at, paid_at
    FROM withdrawals WHERE user_id = ? ORDER BY id DESC
  `).all(req.session.user.id);
  const reservedRc = rows.filter(row => ["pending_review", "approved", "processing", "failed", "legacy_review"].includes(row.status))
    .reduce((total, row) => total + Number(row.amount_rc || 0), 0);
  res.json({ rows, reservedRc });
});

app.post("/api/withdrawals/:id/cancel", requireUser, (req, res) => {
  try {
    db.transaction(() => {
      const withdrawal = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND user_id = ?").get(req.params.id, req.session.user.id);
      if (!withdrawal || withdrawal.status !== "pending_review") throw new Error("WITHDRAWAL_NOT_CANCELLABLE");
      const changed = db.prepare("UPDATE withdrawals SET status = 'cancelled' WHERE id = ? AND status = 'pending_review'").run(withdrawal.id).changes;
      if (!changed) throw new Error("WITHDRAWAL_NOT_CANCELLABLE");
      db.prepare("UPDATE users SET available_rc = available_rc + ? WHERE id = ?").run(withdrawal.amount_rc, req.session.user.id);
      writeLedger({ userId: req.session.user.id, type: "withdrawal_release", amountRc: withdrawal.amount_rc,
        entityType: "withdrawal", entityId: withdrawal.id, idempotencyKey: `withdrawal:${withdrawal.id}:cancel-release`,
        description: `Reserved RC released when ${withdrawal.request_reference} was cancelled.` });
      writeAudit(req.session.user.id, "withdrawal.cancelled", "withdrawal", withdrawal.id, { reference: withdrawal.request_reference });
      notify(req.session.user.id, "withdrawal_cancelled", "Withdrawal cancelled", `${withdrawal.request_reference} was cancelled and its RC returned to your available balance.`, "withdrawal", withdrawal.id);
    }).immediate();
    res.json({ ok: true });
  } catch (error) {
    if (error.message === "WITHDRAWAL_NOT_CANCELLABLE") return res.status(409).json({ error: "Only a request pending review can be cancelled." });
    throw error;
  }
});

app.get("/api/ledger", requireUser, (req, res) => {
  res.json(db.prepare(`
    SELECT reference, entry_type, amount_rc, amount_kobo, status, entity_type, entity_id, description, created_at
    FROM ledger_entries WHERE user_id = ? AND status <> 'reconciliation_required' ORDER BY id DESC LIMIT 100
  `).all(req.session.user.id));
});

app.get("/api/notifications", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50").all(req.session.user.id));
});

app.patch("/api/notifications/:id/read", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});

app.post("/api/support", requireAuth, (req, res) => {
  const { category, subject, message, entityType, entityId } = req.body;
  const categories = ["account", "reward", "withdrawal", "campaign", "other"];
  if (!categories.includes(category) || typeof subject !== "string" || !subject.trim() || subject.length > 150 ||
      typeof message !== "string" || message.trim().length < 10 || message.length > 5000) {
    return res.status(400).json({ error: "Choose a topic and enter a subject and message of at least 10 characters." });
  }
  const result = db.prepare(`
    INSERT INTO support_tickets (user_id, category, subject, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.session.user.id, category, subject.trim(), message.trim(), typeof entityType === "string" ? entityType.slice(0, 30) : "", Number.isSafeInteger(Number(entityId)) ? Number(entityId) : null);
  writeAudit(req.session.user.id, "support.opened", "support_ticket", result.lastInsertRowid, { category });
  res.status(201).json({ ok: true, reference: `SUP-${result.lastInsertRowid}` });
});

app.get("/api/advertiser/profile", requireAdvertiser, (req, res) => {
  const profile = db.prepare("SELECT * FROM advertiser_profiles WHERE user_id = ?").get(req.session.user.id);
  if (!profile) return res.status(404).json({ error: "Advertiser profile not found." });
  res.json(profile);
});

app.get("/api/advertiser/campaigns", requireAdvertiser, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.title, c.description, c.objective, c.status, c.approval_status, c.funding_status,
      c.advertiser_budget_kobo, c.funded_kobo, c.reward_budget_rc, c.reward, c.duration_seconds,
      c.target_completions, c.review_reason, c.created_at,
      (SELECT COUNT(*) FROM views v WHERE v.campaign_id = c.id AND v.status = 'approved') AS approved_results,
      (SELECT COUNT(*) FROM views v WHERE v.campaign_id = c.id AND v.status = 'pending') AS pending_results,
      (SELECT COALESCE(SUM(v.reward), 0) FROM views v WHERE v.campaign_id = c.id AND v.status IN ('pending','approved')) AS committed_rc
    FROM campaigns c WHERE c.advertiser_user_id = ? ORDER BY c.id DESC
  `).all(req.session.user.id);
  res.json(rows);
});

app.patch("/api/advertiser/campaigns/:id", requireAdvertiser, (req, res) => {
  if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "Active must be true or false." });
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND advertiser_user_id = ?").get(req.params.id, req.session.user.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const committed = db.prepare(`SELECT COALESCE(SUM(reward),0) AS reward_rc, COUNT(*) AS count
    FROM views WHERE campaign_id = ? AND status IN ('pending','approved')`).get(campaign.id);
  if (req.body.active && (campaign.approval_status !== "approved" || campaign.funding_status !== "confirmed" ||
      campaign.funded_kobo < campaign.advertiser_budget_kobo || campaign.status !== "paused" ||
      committed.reward_rc >= campaign.reward_budget_rc || (campaign.target_completions > 0 && committed.count >= campaign.target_completions))) {
    return res.status(409).json({ error: "Only an approved, fully funded, paused campaign with remaining reward and target capacity can be resumed." });
  }
  if (!req.body.active && !campaign.active) return res.status(409).json({ error: "This campaign is not currently active." });
  const status = req.body.active ? "active" : "paused";
  db.transaction(() => {
    db.prepare("UPDATE campaigns SET active = ?, status = ? WHERE id = ? AND advertiser_user_id = ?")
      .run(req.body.active ? 1 : 0, status, campaign.id, req.session.user.id);
    writeAudit(req.session.user.id, `campaign.${status}`, "campaign", campaign.id, { source: "advertiser" });
    notify(req.session.user.id, `campaign_${status}`, `Campaign ${status}`, `${campaign.title} is ${status}.`, "campaign", campaign.id);
  }).immediate();
  res.json({ ok: true, status });
});

app.post("/api/advertiser/campaigns", requireAdvertiser, (req, res) => {
  const profile = db.prepare("SELECT * FROM advertiser_profiles WHERE user_id = ?").get(req.session.user.id);
  if (!profile || profile.status !== "approved") return res.status(403).json({ error: "Your advertiser profile must be approved before you can submit a campaign." });
  const { title, description, videoUrl, destinationUrl, durationSeconds, rewardRc, budgetNgn, targetCompletions } = req.body;
  const reward = Number(rewardRc);
  const budgetNgnValue = Number(budgetNgn);
  const duration = Number(durationSeconds);
  const target = Number(targetCompletions || 0);
  const budgetKobo = budgetNgnValue * 100;
  let validVideoUrl = false;
  try { validVideoUrl = ["http:", "https:"].includes(new URL(videoUrl).protocol); } catch {}
  if (typeof title !== "string" || !title.trim() || title.trim().length > 150 ||
      typeof videoUrl !== "string" || !validVideoUrl ||
      (destinationUrl && (typeof destinationUrl !== "string" || (() => { try { return !["http:","https:"].includes(new URL(destinationUrl).protocol); } catch { return true; } })())) ||
      !Number.isSafeInteger(reward) || reward < 1 || !Number.isSafeInteger(budgetNgnValue) || budgetNgnValue < 1 || !Number.isSafeInteger(budgetKobo) ||
      !Number.isSafeInteger(duration) || duration < 1 || duration > 86400 ||
      !Number.isSafeInteger(target) || target < 0 || target > 100000000) {
    return res.status(400).json({ error: "Enter a title, valid video URL, positive integer Naira budget and RC reward, duration, and optional valid target." });
  }
  const allocationBps = getSetting("reward_allocation_bps");
  const rateRc = getSetting("coin_rate_rc");
  const rateKobo = getSetting("coin_rate_kobo");
  const rewardPoolKobo = Number((BigInt(budgetKobo) * BigInt(allocationBps)) / 10000n);
  const rewardBudgetRc = Number((BigInt(rewardPoolKobo) * BigInt(rateRc)) / BigInt(rateKobo));
  if (!Number.isSafeInteger(rewardBudgetRc) || rewardBudgetRc < reward) {
    return res.status(400).json({ error: "This budget does not cover even one completion at the selected reward using the current reward allocation." });
  }
  const result = db.prepare(`
    INSERT INTO campaigns
      (title, advertiser, description, video_url, destination_url, reward, duration_seconds, budget, active, status,
       advertiser_user_id, objective, qualifying_rules, approval_status, funding_status, advertiser_budget_kobo,
       funded_kobo, reward_budget_rc, reward_allocation_bps, reward_rate_rc, reward_rate_kobo, target_completions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending_review', ?, 'video_visibility', ?, 'pending_review', 'unfunded', ?, 0, ?, ?, ?, ?, ?)
  `).run(title.trim(), profile.business_name, typeof description === "string" ? description.trim().slice(0, 2000) : "",
    videoUrl, destinationUrl || "", reward, duration, rewardBudgetRc, req.session.user.id,
    "Visibility task: watch at least 90% of the declared video duration. Each completion is held for administrator review. Playback and external actions cannot be independently verified by this MVP.",
    budgetKobo, rewardBudgetRc, allocationBps, rateRc, rateKobo, target);
  writeAudit(req.session.user.id, "campaign.submitted", "campaign", result.lastInsertRowid,
    { objective: "video_visibility", advertiserBudgetKobo: budgetKobo, rewardBudgetRc, rewardRc: reward });
  notify(req.session.user.id, "campaign_pending_review", "Campaign submitted", `${title.trim()} is awaiting administrator review.`, "campaign", result.lastInsertRowid);
  res.status(201).json({ ok: true, id: result.lastInsertRowid, status: "pending_review", rewardBudgetRc, estimatedRewardBudgetKobo: rewardPoolKobo });
});

app.post("/api/advertiser/campaigns/:id/funding", requireAdvertiser, (req, res) => {
  if (!process.env.ADVERTISER_FUNDING_INSTRUCTIONS) return res.status(503).json({ error: "Advertiser funding is not configured yet. Contact the platform administrator for verified funding instructions." });
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND advertiser_user_id = ?").get(req.params.id, req.session.user.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  if (campaign.approval_status !== "approved") return res.status(409).json({ error: "The campaign must be approved before funding can be submitted." });
  const amountNgn = Number(req.body.amountNgn);
  const reference = typeof req.body.paymentReference === "string" ? req.body.paymentReference.trim() : "";
  const amountKobo = amountNgn * 100;
  if (!Number.isSafeInteger(amountNgn) || amountNgn < 1 || !Number.isSafeInteger(amountKobo) || amountKobo > campaign.advertiser_budget_kobo ||
      !reference || reference.length < 4 || reference.length > 100) {
    return res.status(400).json({ error: "Enter a positive Naira amount within the campaign budget and the bank transfer reference." });
  }
  const outstanding = db.prepare("SELECT COALESCE(SUM(amount_kobo), 0) AS total FROM campaign_fundings WHERE campaign_id = ? AND status IN ('pending_review','confirmed')").get(campaign.id).total;
  if (amountKobo + outstanding > campaign.advertiser_budget_kobo) return res.status(409).json({ error: "This funding request exceeds the amount still due for the campaign." });
  try {
    const result = db.prepare(`
      INSERT INTO campaign_fundings (campaign_id, amount_kobo, status, advertiser_reference, reconciliation_reference, submitted_by)
      VALUES (?, ?, 'pending_review', ?, ?, ?)
    `).run(campaign.id, amountKobo, reference, `PENDING-${crypto.randomBytes(10).toString("hex")}`, req.session.user.id);
    db.prepare("UPDATE campaigns SET funding_status = 'pending_review' WHERE id = ? AND funding_status <> 'confirmed'").run(campaign.id);
    writeAudit(req.session.user.id, "campaign.funding_submitted", "campaign_funding", result.lastInsertRowid, { amountKobo, campaignId: campaign.id });
    notify(req.session.user.id, "funding_pending_review", "Funding submitted for review", `Funding reference ${reference} is awaiting reconciliation.`, "campaign", campaign.id);
    res.status(201).json({ ok: true, fundingId: result.lastInsertRowid, status: "pending_review" });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "That payment reference has already been submitted." });
    throw error;
  }
});

app.get("/api/advertiser/funding-instructions", requireAdvertiser, (req, res) => {
  if (!process.env.ADVERTISER_FUNDING_INSTRUCTIONS) return res.status(503).json({ configured: false, error: "Advertiser funding has not been configured. Contact support; do not transfer money to unverified details." });
  res.json({ configured: true, instructions: process.env.ADVERTISER_FUNDING_INSTRUCTIONS });
});

// Admin APIs
app.get("/api/admin/summary", requireAdmin, (req, res) => {
  const users = db.prepare("SELECT COUNT(*) count FROM users WHERE role = 'user'").get().count;
  const activeUsers30d = db.prepare("SELECT COUNT(DISTINCT user_id) count FROM views WHERE created_at >= datetime('now', '-30 days')").get().count;
  const campaigns = db.prepare("SELECT COUNT(*) count FROM campaigns").get().count;
  const activeCampaigns = db.prepare("SELECT COUNT(*) count FROM campaigns WHERE active = 1").get().count;
  const advertisers = db.prepare("SELECT COUNT(*) count FROM advertiser_profiles").get().count;
  const pendingAdvertisers = db.prepare("SELECT COUNT(*) count FROM advertiser_profiles WHERE status = 'pending_review'").get().count;
  const pendingCampaigns = db.prepare("SELECT COUNT(*) count FROM campaigns WHERE approval_status = 'pending_review'").get().count;
  const pendingFunding = db.prepare("SELECT COUNT(*) count FROM campaign_fundings WHERE status = 'pending_review'").get().count;
  const completedViews = db.prepare("SELECT COUNT(*) count FROM views WHERE status = 'approved'").get().count;
  const pendingViews = db.prepare("SELECT COUNT(*) count FROM views WHERE status = 'pending'").get().count;
  const rewards = db.prepare("SELECT COALESCE(SUM(amount_rc), 0) total FROM ledger_entries WHERE entry_type = 'task_reward_credit' AND status = 'posted'").get().total;
  const confirmedFundingKobo = db.prepare("SELECT COALESCE(SUM(amount_kobo), 0) total FROM campaign_fundings WHERE status = 'confirmed'").get().total;
  const pendingWithdrawals = db.prepare("SELECT COUNT(*) count FROM withdrawals WHERE status = 'pending_review'").get().count;
  const reservedWithdrawalKobo = db.prepare("SELECT COALESCE(SUM(payout_kobo), 0) total FROM withdrawals WHERE status IN ('pending_review','approved','processing','failed')").get().total;
  const paidWithdrawalsKobo = db.prepare("SELECT COALESCE(SUM(payout_kobo), 0) total FROM withdrawals WHERE status = 'paid'").get().total;
  const legacyBalanceKobo = db.prepare("SELECT COALESCE(SUM(legacy_balance_kobo), 0) total FROM users").get().total;
  res.json({ users, activeUsers30d, campaigns, activeCampaigns, advertisers, pendingAdvertisers, pendingCampaigns, pendingFunding,
    completedViews, pendingViews, rewards, confirmedFundingKobo, pendingWithdrawals, reservedWithdrawalKobo, paidWithdrawalsKobo, legacyBalanceKobo });
});

app.get("/api/admin/advertisers", requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT p.id, p.business_name AS name, p.status, p.website, p.created_at, u.name AS contact_name, u.email,
      COUNT(c.id) AS campaigns,
      SUM(CASE WHEN c.active = 1 THEN 1 ELSE 0 END) AS active_campaigns,
      SUM(CASE WHEN c.approval_status = 'pending_review' THEN 1 ELSE 0 END) AS pending_campaigns,
      COALESCE(SUM(CASE WHEN c.id IS NOT NULL THEN c.advertiser_budget_kobo ELSE 0 END), 0) AS requested_budget_kobo,
      COALESCE(SUM(CASE WHEN c.id IS NOT NULL THEN c.funded_kobo ELSE 0 END), 0) AS funded_kobo,
      COALESCE(SUM((SELECT COUNT(*) FROM views v WHERE v.campaign_id = c.id AND v.status = 'approved')), 0) AS approved_results
    FROM advertiser_profiles p JOIN users u ON u.id = p.user_id
    LEFT JOIN campaigns c ON c.advertiser_user_id = p.user_id
    GROUP BY p.id ORDER BY p.id DESC
  `).all());
});

app.get("/api/admin/campaigns", requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, u.name AS advertiser_contact_name, u.email AS advertiser_email,
      COALESCE((SELECT COUNT(*) FROM views v WHERE v.campaign_id = c.id AND v.status = 'approved'), 0) AS completed_views,
      COALESCE((SELECT COUNT(*) FROM views v WHERE v.campaign_id = c.id AND v.status = 'pending'), 0) AS pending_views,
      COALESCE((SELECT SUM(v.reward) FROM views v WHERE v.campaign_id = c.id AND v.status IN ('pending','approved')), 0) AS committed_rc
    FROM campaigns c LEFT JOIN users u ON u.id = c.advertiser_user_id ORDER BY c.id DESC
  `).all());
});

app.patch("/api/admin/advertisers/:id", requireAdmin, (req, res) => {
  const { status, reason } = req.body;
  if (!["approved", "rejected"].includes(status) || (reason !== undefined && (typeof reason !== "string" || reason.length > 1000))) {
    return res.status(400).json({ error: "Choose approved or rejected and provide a valid optional reason." });
  }
  const profile = db.prepare("SELECT * FROM advertiser_profiles WHERE id = ?").get(req.params.id);
  if (!profile) return res.status(404).json({ error: "Advertiser profile not found." });
  db.transaction(() => {
    db.prepare("UPDATE advertiser_profiles SET status = ? WHERE id = ?").run(status, profile.id);
    writeAudit(req.session.user.id, `advertiser.${status}`, "advertiser_profile", profile.id, { reason: (reason || "").slice(0, 1000) });
    notify(profile.user_id, `advertiser_${status}`, `Advertiser profile ${status}`, status === "approved" ? "Your business can now submit campaigns for review." : `Your advertiser profile needs attention. ${reason || "Contact support for details."}`, "advertiser", profile.id);
  }).immediate();
  res.json({ ok: true });
});

app.get("/api/admin/fundings", requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT f.id, f.campaign_id, f.amount_kobo, f.status, f.provider, f.advertiser_reference,
      f.reconciliation_reference, f.verification_note, f.created_at, c.title AS campaign_title,
      p.business_name AS advertiser, u.name AS submitted_by_name, u.email AS submitted_by_email
    FROM campaign_fundings f JOIN campaigns c ON c.id = f.campaign_id
    LEFT JOIN advertiser_profiles p ON p.user_id = c.advertiser_user_id
    JOIN users u ON u.id = f.submitted_by ORDER BY f.id DESC
  `).all());
});

app.post("/api/admin/fundings/:id/reconcile", requireAdmin, (req, res) => {
  const decision = req.body.status;
  const reconciliationReference = typeof req.body.reconciliationReference === "string" ? req.body.reconciliationReference.trim() : "";
  const verificationNote = typeof req.body.verificationNote === "string" ? req.body.verificationNote.trim() : "";
  const actualAmountNgn = Number(req.body.actualAmountNgn);
  const actualAmountKobo = actualAmountNgn * 100;
  if (!["confirmed", "rejected"].includes(decision) || !verificationNote || verificationNote.length > 1000 ||
      (decision === "confirmed" && (!reconciliationReference || reconciliationReference.length > 100 || !Number.isSafeInteger(actualAmountNgn) || actualAmountNgn < 1 || !Number.isSafeInteger(actualAmountKobo)))) {
    return res.status(400).json({ error: "Record a decision and verification note. Confirmation also requires the reconciled bank reference and actual amount received." });
  }
  try {
    db.transaction(() => {
      const funding = db.prepare("SELECT * FROM campaign_fundings WHERE id = ?").get(req.params.id);
      if (!funding || funding.status !== "pending_review") throw new Error("FUNDING_NOT_PENDING");
      const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(funding.campaign_id);
      if (decision === "confirmed") {
        if (actualAmountKobo > funding.amount_kobo) throw new Error("FUNDING_AMOUNT_EXCEEDS_SUBMISSION");
        const changed = db.prepare(`UPDATE campaign_fundings SET amount_kobo = ?, status = 'confirmed', reconciliation_reference = ?,
          verification_note = ?, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending_review'`)
          .run(actualAmountKobo, reconciliationReference, verificationNote, req.session.user.id, funding.id).changes;
        if (!changed) throw new Error("FUNDING_NOT_PENDING");
        const updated = db.prepare("UPDATE campaigns SET funded_kobo = funded_kobo + ? WHERE id = ? AND funded_kobo + ? <= advertiser_budget_kobo")
          .run(actualAmountKobo, campaign.id, actualAmountKobo).changes;
        if (!updated) throw new Error("FUNDING_EXCEEDS_CAMPAIGN_BUDGET");
        const current = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaign.id);
        const fullyFunded = current.funded_kobo >= current.advertiser_budget_kobo && current.advertiser_budget_kobo > 0;
        db.prepare("UPDATE campaigns SET funding_status = ?, active = ?, status = ? WHERE id = ?")
          .run(fullyFunded ? "confirmed" : "pending_review", fullyFunded && current.approval_status === "approved" ? 1 : 0,
            fullyFunded && current.approval_status === "approved" ? "active" : current.approval_status === "approved" ? "approved" : "pending_review", campaign.id);
        writeLedger({ type: "advertiser_funding", amountKobo: actualAmountKobo, entityType: "campaign", entityId: campaign.id,
          idempotencyKey: `campaign-funding:${funding.id}:confirmed`, description: `Advertiser funding reconciled for ${campaign.title}.`,
          actorUserId: req.session.user.id, metadata: { fundingId: funding.id, reconciliationReference } });
        if (campaign.advertiser_user_id) notify(campaign.advertiser_user_id, "funding_confirmed", "Funding confirmed", `${formatNaira(actualAmountKobo)} has been reconciled for ${campaign.title}.`, "campaign", campaign.id);
      } else {
        db.prepare("UPDATE campaign_fundings SET status = 'rejected', verification_note = ?, confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending_review'")
          .run(verificationNote, req.session.user.id, funding.id);
        const outstanding = db.prepare("SELECT COUNT(*) AS count FROM campaign_fundings WHERE campaign_id = ? AND status = 'pending_review'").get(campaign.id).count;
        if (!outstanding && !campaign.funded_kobo) db.prepare("UPDATE campaigns SET funding_status = 'unfunded' WHERE id = ?").run(campaign.id);
        if (campaign.advertiser_user_id) notify(campaign.advertiser_user_id, "funding_rejected", "Funding needs review", `Funding reference ${funding.advertiser_reference} was not reconciled. ${verificationNote}`, "campaign", campaign.id);
      }
      writeAudit(req.session.user.id, `campaign_funding.${decision}`, "campaign_funding", funding.id,
        { campaignId: campaign.id, actualAmountKobo: decision === "confirmed" ? actualAmountKobo : 0, reconciliationReference, verificationNote });
    }).immediate();
    res.json({ ok: true, status: decision });
  } catch (error) {
    if (error.message === "FUNDING_NOT_PENDING") return res.status(409).json({ error: "This funding record has already been processed." });
    if (error.message === "FUNDING_AMOUNT_EXCEEDS_SUBMISSION") return res.status(400).json({ error: "The received amount cannot exceed the submitted amount." });
    if (error.message === "FUNDING_EXCEEDS_CAMPAIGN_BUDGET") return res.status(409).json({ error: "Recording this deposit would exceed the campaign's authorized budget." });
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "That reconciliation reference is already recorded." });
    throw error;
  }
});

app.get("/api/admin/task-reviews", requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT v.id, v.attempt_reference, v.reward, v.watched_seconds, v.created_at, u.id AS user_id, u.name, u.email,
      c.title AS campaign_title, c.reward_budget_rc,
      (SELECT COALESCE(SUM(v2.reward), 0) FROM views v2 WHERE v2.campaign_id = c.id AND v2.status IN ('pending','approved')) AS committed_rc
    FROM views v JOIN users u ON u.id = v.user_id JOIN campaigns c ON c.id = v.campaign_id
    WHERE v.status = 'pending' ORDER BY v.id ASC
  `).all());
});

app.patch("/api/admin/task-reviews/:id", requireAdmin, (req, res) => {
  const { decision, reason } = req.body;
  const rejectionReason = typeof reason === "string" ? reason.trim() : "";
  if (!["approved", "rejected"].includes(decision) || (decision === "rejected" && (!rejectionReason || rejectionReason.length > 1000))) {
    return res.status(400).json({ error: "Choose approve or reject. A clear reason is required for rejection." });
  }
  try {
    db.transaction(() => {
      const view = db.prepare("SELECT * FROM views WHERE id = ?").get(req.params.id);
      if (!view || view.status !== "pending") throw new Error("TASK_NOT_PENDING");
      const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(view.campaign_id);
      if (decision === "approved") {
        const changed = db.prepare("UPDATE users SET pending_rc = pending_rc - ?, available_rc = available_rc + ? WHERE id = ? AND pending_rc >= ?")
          .run(view.reward, view.reward, view.user_id, view.reward).changes;
        if (!changed) throw new Error("PENDING_REWARD_MISMATCH");
        db.prepare("UPDATE views SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
          .run(req.session.user.id, view.id);
        writeLedger({ userId: view.user_id, type: "task_reward_credit", amountRc: view.reward, entityType: "view", entityId: view.id,
          idempotencyKey: `view:${view.id}:approved`, description: `Approved reward for ${campaign.title}.`, actorUserId: req.session.user.id });
        notify(view.user_id, "reward_approved", "Reward approved", `${view.reward.toLocaleString()} RC for ${campaign.title} is now available.`, "view", view.id);
      } else {
        const changed = db.prepare("UPDATE users SET pending_rc = pending_rc - ? WHERE id = ? AND pending_rc >= ?")
          .run(view.reward, view.user_id, view.reward).changes;
        if (!changed) throw new Error("PENDING_REWARD_MISMATCH");
        db.prepare("UPDATE views SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'")
          .run(rejectionReason, req.session.user.id, view.id);
        writeLedger({ userId: view.user_id, type: "task_reward_rejected", entityType: "view", entityId: view.id,
          idempotencyKey: `view:${view.id}:rejected`, description: `Task reward not credited: ${rejectionReason}`, actorUserId: req.session.user.id });
        notify(view.user_id, "reward_rejected", "Reward not approved", `${campaign.title}: ${rejectionReason}`, "view", view.id);
      }
      const refreshedCampaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaign.id);
      const totals = db.prepare(`SELECT COALESCE(SUM(reward),0) AS committed_rc,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
        COUNT(*) AS committed_count FROM views WHERE campaign_id = ? AND status IN ('pending','approved')`).get(campaign.id);
      if (refreshedCampaign.target_completions > 0 && totals.approved_count >= refreshedCampaign.target_completions) {
        db.prepare("UPDATE campaigns SET active = 0, status = 'completed' WHERE id = ?").run(campaign.id);
        if (campaign.advertiser_user_id) notify(campaign.advertiser_user_id, "campaign_completed", "Campaign target reached", `${campaign.title} reached its approved result target.`, "campaign", campaign.id);
      } else if (refreshedCampaign.status === "delivery_paused_pending_review" &&
          totals.committed_rc < refreshedCampaign.reward_budget_rc &&
          (!refreshedCampaign.target_completions || totals.committed_count < refreshedCampaign.target_completions) &&
          refreshedCampaign.approval_status === "approved" && refreshedCampaign.funding_status === "confirmed" &&
          refreshedCampaign.funded_kobo >= refreshedCampaign.advertiser_budget_kobo) {
        db.prepare("UPDATE campaigns SET active = 1, status = 'active' WHERE id = ?").run(campaign.id);
      }
      writeAudit(req.session.user.id, `task_reward.${decision}`, "view", view.id, { userId: view.user_id, rewardRc: view.reward, reason: rejectionReason });
    }).immediate();
    res.json({ ok: true, status: decision });
  } catch (error) {
    if (error.message === "TASK_NOT_PENDING") return res.status(409).json({ error: "This completion has already been reviewed." });
    if (error.message === "PENDING_REWARD_MISMATCH") return res.status(409).json({ error: "The pending reward balance needs reconciliation." });
    throw error;
  }
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT key, value, updated_at FROM platform_settings ORDER BY key").all();
  res.json({ settings: Object.fromEntries(rows.map(row => [row.key, Number(row.value)])), integrations: publicSettings() });
});

app.patch("/api/admin/settings", requireAdmin, (req, res) => {
  const allowed = {
    coin_rate_rc: [1, 1000000000], coin_rate_kobo: [1, 1000000000], minimum_withdrawal_rc: [1, 1000000000],
    withdrawal_fee_kobo: [0, 1000000000], reward_allocation_bps: [1, 10000], variable_cost_bps: [0, 10000]
  };
  const changes = req.body.settings;
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length ||
      Object.entries(changes).some(([key, value]) => !allowed[key] || !Number.isSafeInteger(Number(value)) || Number(value) < allowed[key][0] || Number(value) > allowed[key][1])) {
    return res.status(400).json({ error: "Submit supported integer settings within their allowed ranges." });
  }
  if (("coin_rate_rc" in changes) !== ("coin_rate_kobo" in changes)) return res.status(400).json({ error: "Update both coin_rate_rc and coin_rate_kobo together." });
  const previous = {};
  for (const key of Object.keys(changes)) previous[key] = getSetting(key);
  db.transaction(() => {
    const update = db.prepare("UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?");
    for (const [key, value] of Object.entries(changes)) update.run(String(Number(value)), req.session.user.id, key);
    writeAudit(req.session.user.id, "settings.updated", "platform_settings", null, { previous, changes });
  }).immediate();
  res.json({ ok: true, settings: Object.fromEntries(Object.keys(changes).map(key => [key, getSetting(key)])) });
});

app.post("/api/admin/campaigns", requireAdmin, (req, res) => {
  const { title, advertiser, description, videoUrl, destinationUrl, reward, budget, durationSeconds } = req.body;
  const status = "pending_review";
  const rewardValue = Number(reward);
  const budgetNgn = Number(budget);
  const budgetKobo = budgetNgn * 100;
  const durationValue = Number(durationSeconds);
  const profile = typeof advertiser === "string" ? db.prepare("SELECT * FROM advertiser_profiles WHERE business_name = ? COLLATE NOCASE AND status = 'approved'").get(advertiser.trim()) : null;
  const isHttpUrl = value => {
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
  };
  if (typeof title !== "string" || !title.trim() || title.trim().length > 150 ||
      !profile ||
      typeof videoUrl !== "string" || !isHttpUrl(videoUrl) ||
      (destinationUrl && (typeof destinationUrl !== "string" || !isHttpUrl(destinationUrl))) ||
      !Number.isSafeInteger(rewardValue) || rewardValue <= 0 ||
      !Number.isSafeInteger(durationValue) || durationValue < 1 || durationValue > 24 * 60 * 60 ||
      !Number.isSafeInteger(budgetNgn) || budgetNgn < 1 || !Number.isSafeInteger(budgetKobo)) {
    return res.status(400).json({ error: "Choose an approved advertiser and enter valid campaign details, HTTP(S) URLs, duration, reward, and Naira budget." });
  }
  const poolKobo = Number((BigInt(budgetKobo) * BigInt(getSetting("reward_allocation_bps"))) / 10000n);
  const rateRc = getSetting("coin_rate_rc");
  const rateKobo = getSetting("coin_rate_kobo");
  const rewardBudgetRc = Number((BigInt(poolKobo) * BigInt(rateRc)) / BigInt(rateKobo));
  if (!Number.isSafeInteger(rewardBudgetRc) || rewardBudgetRc < rewardValue) return res.status(400).json({ error: "The campaign budget does not cover the configured reward allocation." });
  const result = db.prepare(`
    INSERT INTO campaigns
    (title, advertiser, description, video_url, destination_url, reward, duration_seconds, budget, active, status,
      advertiser_user_id, objective, approval_status, funding_status, advertiser_budget_kobo, reward_budget_rc, reward_allocation_bps,
      reward_rate_rc, reward_rate_kobo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'video_visibility', 'pending_review', 'unfunded', ?, ?, ?, ?, ?)
  `).run(title.trim(), profile.business_name, typeof description === "string" ? description.slice(0, 2000) : "", videoUrl,
    destinationUrl || "", rewardValue, durationValue, rewardBudgetRc, status, profile.user_id, budgetKobo, rewardBudgetRc,
    getSetting("reward_allocation_bps"), rateRc, rateKobo);
  writeAudit(req.session.user.id, "campaign.created_by_admin", "campaign", result.lastInsertRowid, { advertiserUserId: profile.user_id, rewardBudgetRc });
  notify(profile.user_id, "campaign_pending_review", "Campaign submitted", `${title.trim()} is awaiting administrator review.`, "campaign", result.lastInsertRowid);
  res.status(201).json({ ok: true, id: result.lastInsertRowid, status });
});

app.patch("/api/admin/campaigns/:id", requireAdmin, (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  if (req.body.approvalStatus !== undefined) {
    const approvalStatus = req.body.approvalStatus;
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (!["approved", "rejected"].includes(approvalStatus) || (approvalStatus === "rejected" && (!reason || reason.length > 1000))) {
      return res.status(400).json({ error: "Choose approve or reject. A clear reason is required for rejection." });
    }
    db.transaction(() => {
      const profile = campaign.advertiser_user_id ? db.prepare("SELECT status FROM advertiser_profiles WHERE user_id = ?").get(campaign.advertiser_user_id) : null;
      if (approvalStatus === "approved" && campaign.advertiser_user_id && (!profile || profile.status !== "approved")) throw new Error("ADVERTISER_NOT_APPROVED");
      const funded = campaign.funded_kobo >= campaign.advertiser_budget_kobo && campaign.advertiser_budget_kobo > 0 && campaign.funding_status === "confirmed";
      const active = approvalStatus === "approved" && funded;
      db.prepare("UPDATE campaigns SET approval_status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, active = ?, status = ? WHERE id = ?")
        .run(approvalStatus, reason, req.session.user.id, active ? 1 : 0,
          approvalStatus === "rejected" ? "rejected" : active ? "active" : "approved", campaign.id);
      writeAudit(req.session.user.id, `campaign.${approvalStatus}`, "campaign", campaign.id, { reason, fundedKobo: campaign.funded_kobo });
      if (campaign.advertiser_user_id) notify(campaign.advertiser_user_id, `campaign_${approvalStatus}`,
        `Campaign ${approvalStatus}`, approvalStatus === "approved" ? `${campaign.title} was approved${active ? " and is now active" : "; full funding is still required before activation"}.` : `${campaign.title} was not approved. ${reason}`, "campaign", campaign.id);
    }).immediate();
    return res.json({ ok: true, approvalStatus });
  }
  const status = typeof req.body.status === "string" ? req.body.status : (req.body.active ? "active" : "paused");
  if (!["active", "paused", "terminated"].includes(status)) return res.status(400).json({ error: "Choose active, paused, or terminated." });
  if (status === "active" && (campaign.approval_status !== "approved" || campaign.funding_status !== "confirmed" || campaign.funded_kobo < campaign.advertiser_budget_kobo || campaign.reward_budget_rc <= 0)) {
    return res.status(409).json({ error: "A campaign can be activated only after administrator approval and full funding reconciliation." });
  }
  db.transaction(() => {
    db.prepare("UPDATE campaigns SET active = ?, status = ? WHERE id = ?").run(status === "active" ? 1 : 0, status, campaign.id);
    writeAudit(req.session.user.id, `campaign.${status}`, "campaign", campaign.id, {});
    if (campaign.advertiser_user_id) notify(campaign.advertiser_user_id, `campaign_${status}`, `Campaign ${status}`, `${campaign.title} is ${status}.`, "campaign", campaign.id);
  }).immediate();
  res.json({ ok: true, status });
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.available_rc, u.pending_rc, u.legacy_balance_kobo, u.created_at,
      COALESCE((SELECT SUM(l.amount_rc) FROM ledger_entries l WHERE l.user_id = u.id AND l.entry_type = 'task_reward_credit' AND l.status = 'posted'), 0) AS lifetime_rewards_rc,
      (SELECT COUNT(*) FROM views v WHERE v.user_id = u.id AND v.status = 'approved') AS completed_campaigns
    FROM users u ORDER BY u.id DESC
  `).all());
});

app.get("/api/admin/withdrawals", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT w.id, w.user_id, w.request_reference AS reference, w.amount_rc, w.gross_kobo, w.fee_kobo, w.payout_kobo,
      w.bank_name, w.destination_encrypted, w.account_last4, w.status, w.rejection_reason, w.payout_reference, w.payout_evidence,
      w.created_at, w.reviewed_at, w.processing_at, w.paid_at, u.name, u.email
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    ORDER BY w.id DESC
  `).all();
  res.json(rows.map(row => {
    let destination = null;
    if (row.destination_encrypted) {
      try { destination = decryptBankDetails(row.destination_encrypted); } catch { destination = null; }
    }
    delete row.destination_encrypted;
    return { ...row, destination, legacy: !row.amount_rc };
  }));
});

app.patch("/api/admin/withdrawals/:id", requireAdmin, (req, res) => {
  const { status } = req.body;
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  const payoutReference = typeof req.body.payoutReference === "string" ? req.body.payoutReference.trim() : "";
  const payoutEvidence = typeof req.body.payoutEvidence === "string" ? req.body.payoutEvidence.trim() : "";
  if (!["approved", "rejected", "processing", "paid", "failed"].includes(status)) return res.status(400).json({ error: "Choose an allowed withdrawal action." });
  if (["rejected", "failed"].includes(status) && (!reason || reason.length > 1000)) return res.status(400).json({ error: "A clear reason is required for rejection or failure." });
  if (status === "paid" && (!payoutReference || payoutReference.length > 150 || payoutEvidence.length < 10 || payoutEvidence.length > 2000)) {
    return res.status(400).json({ error: "Record a payout reference and at least 10 characters describing the evidence checked before marking paid." });
  }
  try {
    db.transaction(() => {
      const withdrawal = db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(req.params.id);
      if (!withdrawal || withdrawal.amount_rc <= 0 || withdrawal.status === "legacy_review") throw new Error("WITHDRAWAL_LEGACY_OR_MISSING");
      const allowed = {
        pending_review: ["approved", "rejected"],
        approved: ["processing", "rejected"],
        processing: ["paid", "failed"],
        failed: ["processing", "rejected"]
      };
      if (!allowed[withdrawal.status]?.includes(status)) throw new Error("WITHDRAWAL_TRANSITION_INVALID");
      if (withdrawal.status === "failed" && status === "processing" && !reason) throw new Error("RECONCILIATION_REASON_REQUIRED");
      if (status === "rejected") {
        db.prepare("UPDATE users SET available_rc = available_rc + ? WHERE id = ?").run(withdrawal.amount_rc, withdrawal.user_id);
        writeLedger({ userId: withdrawal.user_id, type: "withdrawal_release", amountRc: withdrawal.amount_rc,
          entityType: "withdrawal", entityId: withdrawal.id, idempotencyKey: `withdrawal:${withdrawal.id}:release`,
          description: `RC released after withdrawal ${withdrawal.request_reference} was rejected.`, actorUserId: req.session.user.id });
        db.prepare("UPDATE withdrawals SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(reason, req.session.user.id, withdrawal.id);
        notify(withdrawal.user_id, "withdrawal_rejected", "Withdrawal rejected", `${withdrawal.request_reference}: ${reason}. Reserved RC has been returned.`, "withdrawal", withdrawal.id);
      } else if (status === "approved") {
        db.prepare("UPDATE withdrawals SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(req.session.user.id, withdrawal.id);
        notify(withdrawal.user_id, "withdrawal_approved", "Withdrawal approved", `${withdrawal.request_reference} is approved and awaiting manual processing.`, "withdrawal", withdrawal.id);
      } else if (status === "processing") {
        db.prepare("UPDATE withdrawals SET status = 'processing', processing_at = COALESCE(processing_at, CURRENT_TIMESTAMP) WHERE id = ?")
          .run(withdrawal.id);
        notify(withdrawal.user_id, "withdrawal_processing", "Withdrawal processing", `${withdrawal.request_reference} is being processed manually.`, "withdrawal", withdrawal.id);
      } else if (status === "failed") {
        db.prepare("UPDATE withdrawals SET status = 'failed', rejection_reason = ? WHERE id = ?").run(reason, withdrawal.id);
        notify(withdrawal.user_id, "withdrawal_failed", "Payout needs review", `${withdrawal.request_reference} needs reconciliation. ${reason}`, "withdrawal", withdrawal.id);
      } else {
        db.prepare("UPDATE withdrawals SET status = 'paid', payout_reference = ?, payout_evidence = ?, paid_by = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(payoutReference, payoutEvidence, req.session.user.id, withdrawal.id);
        writeLedger({ userId: withdrawal.user_id, type: "withdrawal_paid", amountKobo: -withdrawal.payout_kobo,
          entityType: "withdrawal", entityId: withdrawal.id, idempotencyKey: `withdrawal:${withdrawal.id}:paid`,
          description: `Manual payout recorded for ${withdrawal.request_reference}.`, actorUserId: req.session.user.id,
          metadata: { payoutReference } });
        notify(withdrawal.user_id, "withdrawal_paid", "Withdrawal paid", `${withdrawal.request_reference} was marked paid after payout evidence was recorded.`, "withdrawal", withdrawal.id);
      }
      writeAudit(req.session.user.id, `withdrawal.${status}`, "withdrawal", withdrawal.id,
        { reference: withdrawal.request_reference, reason, payoutReference, payoutEvidence: status === "paid" ? payoutEvidence : undefined });
    }).immediate();
    res.json({ ok: true, status });
  } catch (error) {
    if (error.message === "WITHDRAWAL_LEGACY_OR_MISSING") return res.status(409).json({ error: "This request is legacy or missing. Reconcile it separately; it cannot be processed through the new RC payout flow." });
    if (error.message === "WITHDRAWAL_TRANSITION_INVALID") return res.status(409).json({ error: "That withdrawal status transition is not allowed." });
    if (error.message === "RECONCILIATION_REASON_REQUIRED") return res.status(400).json({ error: "Explain how the failed payout was reconciled before retrying it." });
    throw error;
  }
});

app.get("/api/admin/support", requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, u.name AS user_name, u.email AS user_email
    FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC LIMIT 200
  `).all());
});

app.patch("/api/admin/support/:id", requireAdmin, (req, res) => {
  const status = req.body.status;
  const response = typeof req.body.response === "string" ? req.body.response.trim() : "";
  if (!["open", "in_review", "resolved"].includes(status) || (status === "resolved" && (!response || response.length > 3000)) || response.length > 3000) {
    return res.status(400).json({ error: "Choose a valid ticket status and include a response when resolving." });
  }
  const ticket = db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Support request not found." });
  db.transaction(() => {
    db.prepare("UPDATE support_tickets SET status = ?, admin_response = ?, resolved_by = ?, resolved_at = CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END WHERE id = ?")
      .run(status, response, req.session.user.id, status, ticket.id);
    writeAudit(req.session.user.id, `support.${status}`, "support_ticket", ticket.id, {});
    if (response) notify(ticket.user_id, "support_response", "Support updated your request", `Support request SUP-${ticket.id}: ${response}`, "support_ticket", ticket.id);
  }).immediate();
  res.json({ ok: true, status });
});

app.get("/api/admin/audit", requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json(db.prepare(`
    SELECT a.id, a.actor_user_id, u.name AS actor_name, a.action, a.entity_type, a.entity_id, a.details, a.created_at
    FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT ?
  `).all(limit));
});

app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`RewardHub running at http://localhost:${PORT}`);
  });
}

module.exports = { app, db };
