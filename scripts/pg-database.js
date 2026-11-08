const { AsyncLocalStorage } = require("node:async_hooks");

const identityTables = new Set(["users", "advertiser_profiles", "ledger_entries", "audit_logs", "notifications", "campaigns", "free_videos", "views", "withdrawals", "campaign_fundings", "support_tickets", "action_reward_claims", "password_reset_tokens"]);

function postgresSql(source) {
  let sql = source;
  const ignoredInsert = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  sql = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
  sql = sql.replace(/json_extract\(sess,\s*'\$\.user\.id'\)/gi, "(sess->'user'->>'id')");
  sql = sql.replace(/datetime\('now',\s*'-(\d+) days'\)/gi, "to_char(NOW() - INTERVAL '$1 days', 'YYYY-MM-DD HH24:MI:SS')");
  sql = sql.replace(/\bCURRENT_TIMESTAMP\b/gi, "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')");
  sql = sql.replace(/([\w.]+)\s*=\s*(\?)\s+COLLATE\s+NOCASE/gi, "LOWER($1) = LOWER($2)");
  sql = sql.replace(/\s+COLLATE\s+NOCASE/gi, "");
  let out = "", quote = null, index = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote && sql[i + 1] === quote) out += sql[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch === "`" ? '"' : ch; out += quote; continue; }
    if (ch === "?") { out += `$${++index}`; continue; }
    out += ch;
  }
  sql = out.replace(/\s+COLLATE\s+NOCASE/gi, "");
  if (ignoredInsert && !/\bON\s+CONFLICT\b/i.test(sql)) sql = `${sql.trim().replace(/;$/, "")} ON CONFLICT DO NOTHING`;
  return sql;
}

class PgDatabase {
  constructor(pool) { this.pool = pool; this.context = new AsyncLocalStorage(); }

  async query(sql, params = []) {
    const client = this.context.getStore();
    return (client || this.pool).query(postgresSql(sql), params);
  }

  prepare(sql) {
    return {
      get: async (...params) => (await this.query(sql, params)).rows[0],
      all: async (...params) => (await this.query(sql, params)).rows,
      run: async (...params) => {
        let statement = sql;
        const insert = statement.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
        const hasReturning = /\bRETURNING\b/i.test(statement);
        if (insert && identityTables.has(insert[1].toLowerCase()) && !hasReturning) statement = `${statement.trim().replace(/;$/, "")} RETURNING id`;
        const result = await this.query(statement, params);
        return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id == null ? undefined : Number(result.rows[0].id) };
      }
    };
  }

  transaction(work) {
    const execute = async (...args) => {
      const parent = this.context.getStore();
      if (parent) {
        const savepoint = `rh_sp_${Math.random().toString(36).slice(2)}`;
        await parent.query(`SAVEPOINT ${savepoint}`);
        try { const result = await work(...args); await parent.query(`RELEASE SAVEPOINT ${savepoint}`); return result; }
        catch (error) { await parent.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); throw error; }
      }
      const client = await this.pool.connect();
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
            const result = await this.context.run(client, () => work(...args));
            await client.query("COMMIT");
            return result;
          } catch (error) {
            try { await client.query("ROLLBACK"); } catch {}
            if (attempt >= 8 || !["40001", "40P01"].includes(error.code)) throw error;
            const delayMs = Math.min(5 * (2 ** attempt), 160) + Math.floor(Math.random() * 10);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      } finally { client.release(); }
    };
    execute.immediate = execute;
    return execute;
  }
}

module.exports = { PgDatabase, postgresSql };
