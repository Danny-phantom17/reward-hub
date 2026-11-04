const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createPool, migrate } = require("./migrate");

const order = ["users", "campaigns", "advertiser_profiles", "platform_settings", "app_migrations", "ledger_entries", "audit_logs", "notifications", "views", "withdrawals", "campaign_fundings", "support_tickets", "watch_sessions", "campaign_tracking_sessions", "campaign_tracking_events", "action_reward_claims", "rate_limit_hits", "password_reset_tokens", "session_store"];
const requiredTables = new Set(["users", "campaigns", "platform_settings", "app_migrations", "ledger_entries", "views", "withdrawals"]);
const identityTables = new Set(["users", "campaigns", "advertiser_profiles", "ledger_entries", "audit_logs", "notifications", "views", "withdrawals", "campaign_fundings", "support_tickets", "action_reward_claims", "password_reset_tokens"]);

function normalizeValue(table, column, value) {
  if (value === null || table !== "session_store") return value;
  if (table === "session_store" && column === "sess") {
    try { return JSON.stringify(JSON.parse(value)); } catch { throw new Error("A SQLite session row contains invalid JSON; import stopped."); }
  }
  if (table === "session_store" && column === "expire") return new Date(Number(value)).toISOString();
  return value;
}

async function importSqlite(filename, pool, { mode = "account-preserving" } = {}) {
  if (mode !== "account-preserving") throw new Error("Only account-preserving clean-launch imports are supported.");
  const absolute = path.resolve(filename);
  if (!fs.existsSync(absolute)) throw new Error(`SQLite source was not found: ${absolute}`);
  const sqlite = new DatabaseSync(absolute, { readOnly: true });
  sqlite.exec("PRAGMA query_only = ON; BEGIN");
  const integrity = sqlite.prepare("PRAGMA integrity_check").get().integrity_check;
  if (integrity !== "ok") { sqlite.close(); throw new Error(`SQLite integrity check failed: ${integrity}`); }
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  for (const table of requiredTables) if (!tables.includes(table)) { sqlite.close(); throw new Error(`SQLite source is missing core table ${table}; no import was attempted.`); }
  const unknownTables = tables.filter(table => !order.includes(table));
  if (unknownTables.length) { sqlite.close(); throw new Error(`SQLite source contains unmapped tables (${unknownTables.join(", ")}); no import was attempted.`); }
  const tableCounts = Object.fromEntries(tables.map(t => [t, sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
  const userColumns = new Set(sqlite.prepare('PRAGMA table_info("users")').all().map(column => column.name));
  const users = sqlite.prepare(`SELECT COALESCE(SUM(${userColumns.has("balance") ? "balance" : "0"}),0) AS balance, COALESCE(SUM(available_rc),0) AS available, COALESCE(SUM(pending_rc),0) AS pending, COALESCE(SUM(legacy_balance_kobo),0) AS legacy FROM users`).get();
  const financialActivity = {
    balances: users,
    ledgerRows: sqlite.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get().n,
    fundingRows: tables.includes("campaign_fundings") ? sqlite.prepare("SELECT COUNT(*) AS n FROM campaign_fundings").get().n : 0,
    viewRows: sqlite.prepare("SELECT COUNT(*) AS n FROM views").get().n,
    withdrawalRows: sqlite.prepare("SELECT COUNT(*) AS n FROM withdrawals").get().n,
    pendingActionClaims: tables.includes("action_reward_claims") ? sqlite.prepare("SELECT COUNT(*) AS n FROM action_reward_claims WHERE status IN ('pending','approved')").get().n : 0,
    openSupportTickets: tables.includes("support_tickets") ? sqlite.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE status NOT IN ('resolved','closed')").get().n : 0,
  };
  const totals = { users, ledger: sqlite.prepare("SELECT COALESCE(SUM(amount_rc),0) AS rc, COALESCE(SUM(amount_kobo),0) AS kobo FROM ledger_entries").get(), funding: sqlite.prepare("SELECT COALESCE(SUM(amount_kobo),0) AS submitted, COALESCE(SUM(CASE WHEN status='confirmed' THEN amount_kobo ELSE 0 END),0) AS confirmed FROM campaign_fundings").get(), rewards: sqlite.prepare("SELECT COALESCE(SUM(reward),0) AS rc FROM views WHERE status IN ('pending','approved')").get(), withdrawals: sqlite.prepare("SELECT COALESCE(SUM(amount_rc),0) AS rc, COALESCE(SUM(gross_kobo),0) AS gross, COALESCE(SUM(payout_kobo),0) AS payout FROM withdrawals").get() };
  if (Number(users.balance) || Number(users.available) || Number(users.pending) || Number(users.legacy) || Object.values(financialActivity).slice(1).some(Number)) {
    sqlite.close();
    throw new Error(`Clean launch refused: financial/reward rows or balances exist, or open support tickets need review. ${JSON.stringify(financialActivity)}`);
  }

  const hash = require("node:crypto").createHash("sha256").update(JSON.stringify(tableCounts));
  const preserveTables = new Set(["users", "advertiser_profiles", "platform_settings", "app_migrations"]);
  for (const table of order.filter(name => tables.includes(name) && preserveTables.has(name))) {
    const columns = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(column => column.name);
    hash.update(`${table}\0${columns.join("\0")}\0`);
    for (const row of sqlite.prepare(`SELECT * FROM "${table}"`).all().map(row => JSON.stringify(row)).sort()) hash.update(`${row}\0`);
  }
  const sourceHash = hash.digest("hex");
  let client;
  try { client = await pool.connect(); }
  catch (error) { sqlite.close(); throw error; }
  try {
    await client.query("BEGIN");
    await client.query("CREATE TABLE IF NOT EXISTS sqlite_imports (source_sha256 TEXT PRIMARY KEY, source_name TEXT NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), summary JSONB NOT NULL)");
    const previous = await client.query("SELECT 1 FROM sqlite_imports WHERE source_sha256 = $1", [sourceHash]);
    if (previous.rowCount) { await client.query("ROLLBACK"); return { skipped: true, reason: "This exact SQLite file was already imported.", sourceHash }; }
    const populated = [];
    for (const table of order) {
      const exists = await client.query("SELECT to_regclass($1) AS relation", [`public.${table}`]);
      if (exists.rows[0].relation && Number((await client.query(`SELECT COUNT(*)::bigint AS n FROM "${table}"`)).rows[0].n) > 0) populated.push(table);
    }
    if (populated.length) throw new Error(`Target PostgreSQL tables are not empty (${populated.join(", ")}); refusing to merge financial data.`);
    for (const table of order.filter(name => tables.includes(name) && preserveTables.has(name))) {
      const sourceColumns = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
      const columns = table === "session_store" ? sourceColumns.map(c => c === "expires" ? "expire" : c) : sourceColumns;
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
      for (const row of rows) {
        const values = sourceColumns.map(column => normalizeValue(table, column === "expires" ? "expire" : column, row[column]));
        const placeholders = values.map((_, i) => `$${i + 1}`).join(",");
        await client.query(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(",")}) VALUES (${placeholders})`, values);
      }
    }
    for (const table of order.filter(table => tables.includes(table) && preserveTables.has(table) && identityTables.has(table))) {
      const seq = await client.query("SELECT pg_get_serial_sequence($1, 'id') AS name", [`public.${table}`]);
      if (!seq.rows[0].name) throw new Error(`PostgreSQL identity sequence missing for ${table}; import stopped.`);
      await client.query(`SELECT setval($1, COALESCE((SELECT MAX(id) FROM "${table}"), 1), EXISTS(SELECT 1 FROM "${table}"))`, [seq.rows[0].name]);
    }
    const checkCounts = {};
    for (const table of tables.filter(table => preserveTables.has(table))) checkCounts[table] = Number((await client.query(`SELECT COUNT(*)::bigint AS n FROM "${table}"`)).rows[0].n);
    for (const table of Object.keys(checkCounts)) if (checkCounts[table] !== tableCounts[table]) throw new Error(`Row count mismatch in ${table}: SQLite ${tableCounts[table]}, PostgreSQL ${checkCounts[table]}.`);
    const after = await client.query("SELECT COALESCE(SUM(balance),0)::bigint AS balance, COALESCE(SUM(available_rc),0)::bigint AS available, COALESCE(SUM(pending_rc),0)::bigint AS pending, COALESCE(SUM(legacy_balance_kobo),0)::bigint AS legacy FROM users");
    const ledgerAfter = await client.query("SELECT COALESCE(SUM(amount_rc),0)::bigint AS rc, COALESCE(SUM(amount_kobo),0)::bigint AS kobo FROM ledger_entries");
    const fundingAfter = await client.query("SELECT COALESCE(SUM(amount_kobo),0)::bigint AS submitted, COALESCE(SUM(amount_kobo) FILTER (WHERE status='confirmed'),0)::bigint AS confirmed FROM campaign_fundings");
    const rewardsAfter = await client.query("SELECT COALESCE(SUM(reward),0)::bigint AS rc FROM views WHERE status IN ('pending','approved')");
    const withdrawalsAfter = await client.query("SELECT COALESCE(SUM(amount_rc),0)::bigint AS rc, COALESCE(SUM(gross_kobo),0)::bigint AS gross, COALESCE(SUM(payout_kobo),0)::bigint AS payout FROM withdrawals");
    const compare = (a, b) => JSON.stringify(Object.values(a).map(String)) === JSON.stringify(Object.values(b.rows[0]).map(String));
    const checks = { balances: compare(users, after), ledger: compare(totals.ledger, ledgerAfter), funding: compare(totals.funding, fundingAfter), rewards: compare(totals.rewards, rewardsAfter), withdrawals: compare(totals.withdrawals, withdrawalsAfter) };
    if (Object.values(checks).some(ok => !ok)) throw new Error(`Financial integrity check failed: ${JSON.stringify(checks)}. Transaction rolled back.`);
    const resetCandidates = Object.fromEntries(Object.entries(tableCounts).filter(([table]) => !preserveTables.has(table)));
    const summary = { mode, preservedTables: [...preserveTables].filter(table => tables.includes(table)), counts: Object.fromEntries(Object.entries(tableCounts).filter(([table]) => preserveTables.has(table))), resetCandidates, financialTotals: totals, checks };
    await client.query("INSERT INTO sqlite_imports(source_sha256,source_name,summary) VALUES($1,$2,$3::jsonb)", [sourceHash, path.basename(absolute), JSON.stringify(summary)]);
    await client.query("COMMIT");
    return { skipped: false, sourceHash, summary };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); sqlite.close(); }
}

async function main() {
  const source = process.argv[2];
  if (!source) throw new Error("Usage: node scripts/import-sqlite.js <path-to-sqlite-file> (account-preserving clean-launch mode)");
  const pool = createPool();
  try { await migrate(pool); console.log(JSON.stringify(await importSqlite(source, pool), null, 2)); }
  finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(`Import stopped safely: ${error.message}`); process.exitCode = 1; });
module.exports = { importSqlite };
