const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const { PGlite } = require("@electric-sql/pglite");
const { migrate } = require("../scripts/migrate");
const { importSqlite } = require("../scripts/import-sqlite");
const { PgDatabase, postgresSql } = require("../scripts/pg-database");

function createFixture(filename, { financial = true } = {}) {
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, available_rc INTEGER NOT NULL DEFAULT 0, pending_rc INTEGER NOT NULL DEFAULT 0, legacy_balance_kobo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE campaigns (id INTEGER PRIMARY KEY, title TEXT NOT NULL, advertiser TEXT NOT NULL, description TEXT, video_url TEXT NOT NULL, destination_url TEXT, reward INTEGER NOT NULL, duration_seconds INTEGER NOT NULL, budget INTEGER NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, advertiser_user_id INTEGER, objective TEXT NOT NULL, qualifying_rules TEXT NOT NULL, approval_status TEXT NOT NULL, funding_status TEXT NOT NULL, advertiser_budget_kobo INTEGER NOT NULL, funded_kobo INTEGER NOT NULL, reward_budget_rc INTEGER NOT NULL, reward_allocation_bps INTEGER NOT NULL, reward_rate_rc INTEGER NOT NULL, reward_rate_kobo INTEGER NOT NULL, target_completions INTEGER NOT NULL, review_reason TEXT NOT NULL, reviewed_by INTEGER, reviewed_at TEXT, expires_at TEXT);
    CREATE TABLE advertiser_profiles (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, business_name TEXT NOT NULL, website TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY, reference TEXT NOT NULL, user_id INTEGER, entry_type TEXT NOT NULL, amount_rc INTEGER NOT NULL, amount_kobo INTEGER NOT NULL, status TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER, idempotency_key TEXT NOT NULL, description TEXT NOT NULL, actor_user_id INTEGER, metadata TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE views (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, campaign_id INTEGER NOT NULL, reward INTEGER NOT NULL, watched_seconds INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, attempt_reference TEXT NOT NULL, rejection_reason TEXT NOT NULL, reviewed_by INTEGER, reviewed_at TEXT);
    CREATE TABLE withdrawals (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, account_details TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, request_reference TEXT NOT NULL, amount_rc INTEGER NOT NULL, gross_kobo INTEGER NOT NULL, fee_kobo INTEGER NOT NULL, payout_kobo INTEGER NOT NULL, bank_name TEXT NOT NULL, destination_encrypted TEXT NOT NULL, account_last4 TEXT NOT NULL, account_name TEXT NOT NULL, rate_rc INTEGER NOT NULL, rate_kobo INTEGER NOT NULL, idempotency_key TEXT NOT NULL, rejection_reason TEXT NOT NULL, payout_reference TEXT NOT NULL, payout_evidence TEXT NOT NULL, reviewed_by INTEGER, reviewed_at TEXT, processing_at TEXT, paid_at TEXT, paid_by INTEGER);
    CREATE TABLE campaign_fundings (id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, amount_kobo INTEGER NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, advertiser_reference TEXT NOT NULL, reconciliation_reference TEXT NOT NULL, submitted_by INTEGER NOT NULL, confirmed_by INTEGER, verification_note TEXT NOT NULL, confirmed_at TEXT, created_at TEXT NOT NULL);
    INSERT INTO users VALUES (9,'Fixture','fixture@example.test','hash','user',0,'2026-01-01',1200,300,500);
    INSERT INTO campaigns VALUES (4,'Campaign','Fixture Advertiser','','https://example.test/video.mp4','',25,10,100,0,'2026-01-01','draft',9,'video_visibility','','approved','unfunded',10000,0,0,4000,1000,10000,2,'',NULL,NULL,NULL);
    INSERT INTO app_migrations VALUES ('coin-rate-10k-rc-per-1000-ngn-v1','2026-01-01');
    INSERT INTO ledger_entries VALUES (12,'L-12',9,'reward',500,0,'posted','view',1,'view-1','fixture',NULL,'{}','2026-01-01');
    INSERT INTO campaign_fundings VALUES (2,4,2500,'confirmed','manual','F-1','R-1',9,9,'verified','2026-01-01','2026-01-01');
    INSERT INTO views VALUES (1,9,4,200,10,'approved','2026-01-01','A-1','',NULL,NULL);
    INSERT INTO withdrawals VALUES (7,9,100,'bank','encrypted','paid','2026-01-01','W-1',100,1000,0,1000,'Bank','','1234','Fixture',10000,100000,'wd-1','','P-1','evidence',9,'2026-01-01',NULL,'2026-01-01',9);
  `);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = 9").run(bcrypt.hashSync("fixture-password", 4));
  if (!financial) db.exec("UPDATE users SET available_rc=0,pending_rc=0,legacy_balance_kobo=0; DELETE FROM ledger_entries; DELETE FROM campaign_fundings; DELETE FROM views; DELETE FROM withdrawals;");
  db.close();
}

test("PostgreSQL schema migration and SQLite import preserve fixture financial totals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewardhub-pg-import-"));
  const sqliteFile = path.join(dir, "fixture.sqlite");
  createFixture(sqliteFile, { financial: false });
  const pg = new PGlite();
  const query = (...args) => args.length === 1 && args[0].includes(";") ? pg.exec(args[0]) : pg.query(...args);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await migrate(pool);
    await migrate(pool);
    const result = await importSqlite(sqliteFile, pool);
    assert.equal(result.skipped, false);
    assert.deepEqual(result.summary.checks, { balances: true, ledger: true, funding: true, rewards: true, withdrawals: true });
    assert.equal(result.summary.counts.users, 1);
    assert.equal(result.summary.resetCandidates.campaigns, 1);
    assert.equal((await pg.query("SELECT COUNT(*)::int AS n FROM campaigns")).rows[0].n, 0);
    const duplicate = await importSqlite(sqliteFile, pool);
    assert.equal(duplicate.skipped, true);
    const user = await pg.query("SELECT available_rc, pending_rc, legacy_balance_kobo FROM users WHERE id=9");
    assert.deepEqual(user.rows[0], { available_rc: 0, pending_rc: 0, legacy_balance_kobo: 0 });
    const account = await pg.query("SELECT id,email,password_hash,role,created_at FROM users WHERE id=9");
    assert.equal(account.rows[0].email, "fixture@example.test");
    assert.equal(account.rows[0].role, "user");
    assert.equal(await bcrypt.compare("fixture-password", account.rows[0].password_hash), true);
  } finally {
    await pg.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("clean-launch import refuses any source containing financial or reward records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewardhub-pg-safety-"));
  const sqliteFile = path.join(dir, "financial-fixture.sqlite");
  createFixture(sqliteFile);
  const pg = new PGlite();
  const query = (...args) => args.length === 1 && args[0].includes(";") ? pg.exec(args[0]) : pg.query(...args);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await migrate(pool);
    await assert.rejects(importSqlite(sqliteFile, pool), /financial\/reward rows or balances exist/);
    assert.equal((await pg.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n, 0);
  } finally {
    await pg.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("clean-launch import also refuses a nonzero legacy user balance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewardhub-pg-balance-safety-"));
  const sqliteFile = path.join(dir, "legacy-balance-fixture.sqlite");
  createFixture(sqliteFile, { financial: false });
  const source = new DatabaseSync(sqliteFile);
  source.prepare("UPDATE users SET balance=1 WHERE id=9").run();
  source.close();
  const pg = new PGlite();
  const query = (...args) => args.length === 1 && args[0].includes(";") ? pg.exec(args[0]) : pg.query(...args);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await migrate(pool);
    await assert.rejects(importSqlite(sqliteFile, pool), /financial\/reward rows or balances exist/);
    assert.equal((await pg.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n, 0);
  } finally {
    await pg.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("clean-launch import refuses outstanding action-reward claims", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewardhub-pg-claim-safety-"));
  const sqliteFile = path.join(dir, "pending-claim-fixture.sqlite");
  createFixture(sqliteFile, { financial: false });
  const source = new DatabaseSync(sqliteFile);
  source.exec("CREATE TABLE action_reward_claims (id INTEGER PRIMARY KEY, status TEXT NOT NULL, reward_rc INTEGER NOT NULL); INSERT INTO action_reward_claims VALUES (1, 'pending', 500);");
  source.close();
  const pg = new PGlite();
  const query = (...args) => args.length === 1 && args[0].includes(";") ? pg.exec(args[0]) : pg.query(...args);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await migrate(pool);
    await assert.rejects(importSqlite(sqliteFile, pool), /financial\/reward rows or balances exist/);
    assert.equal((await pg.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n, 0);
  } finally {
    await pg.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("clean-launch import refuses unresolved support tickets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewardhub-pg-support-safety-"));
  const sqliteFile = path.join(dir, "open-support-fixture.sqlite");
  createFixture(sqliteFile, { financial: false });
  const source = new DatabaseSync(sqliteFile);
  source.exec("CREATE TABLE support_tickets (id INTEGER PRIMARY KEY, status TEXT NOT NULL); INSERT INTO support_tickets VALUES (1, 'open');");
  source.close();
  const pg = new PGlite();
  const query = (...args) => args.length === 1 && args[0].includes(";") ? pg.exec(args[0]) : pg.query(...args);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  try {
    await migrate(pool);
    await assert.rejects(importSqlite(sqliteFile, pool), /open support tickets need review/);
    assert.equal((await pg.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n, 0);
  } finally {
    await pg.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("PostgreSQL query adapter translates parameters and rolls back transactions", async () => {
  const pg = new PGlite();
  const pool = {
    query: (...args) => pg.query(...args),
    connect: async () => ({ query: (...args) => pg.query(...args), release() {} })
  };
  const db = new PgDatabase(pool);
  try {
    await pg.exec("CREATE TABLE users (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, value TEXT NOT NULL)");
    const inserted = await db.prepare("INSERT INTO users(value) VALUES (?)").run("safe-value");
    assert.equal(inserted.changes, 1);
    assert.equal(inserted.lastInsertRowid, 1);
    assert.match(postgresSql("SELECT * FROM users WHERE value = ?"), /value = \$1/);
    assert.match(postgresSql("INSERT OR IGNORE INTO users(value) VALUES (?)"), /ON CONFLICT DO NOTHING/);
    assert.match(postgresSql("UPDATE withdrawals SET processing_at = COALESCE(processing_at, CURRENT_TIMESTAMP)"), /COALESCE\(processing_at, to_char\(NOW\(\)/);
    await assert.rejects(db.transaction(async () => {
      await db.prepare("INSERT INTO users(value) VALUES (?)").run("rolled-back");
      throw new Error("test rollback");
    }), /test rollback/);
    const rows = await db.prepare("SELECT value FROM users ORDER BY id").all();
    assert.deepEqual(rows, [{ value: "safe-value" }]);
  } finally { await pg.close(); }
});
