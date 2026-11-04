const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  const sslRequired = process.env.PGSSL === "true" || process.env.PGSSL !== "false" &&
    (sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full" ||
      process.env.NODE_ENV === "production" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1");
  return new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 10), idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000, ...(sslRequired ? { ssl: { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" } } : {}) });
}

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const file = "001_initial_postgres.sql";
  const found = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
  if (found.rowCount) return;
  const sql = await fs.readFile(path.join(__dirname, "..", "migrations", file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const alreadyInitialized = await client.query("SELECT to_regclass('users') AS users");
    if (alreadyInitialized.rows[0].users) throw new Error("PostgreSQL already has RewardHub tables but no migration record. Refusing to modify it.");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

if (require.main === module) {
  const pool = createPool();
  migrate(pool).then(() => console.log("PostgreSQL migrations are up to date.")).catch(error => {
    console.error(`PostgreSQL migration failed: ${error.message}`); process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { createPool, migrate };
