# PostgreSQL migration status

> **Not ready for deployment.** PostgreSQL 18 is installed locally, its Windows service is running, pgAdmin opens, and port 5432 is reachable. No test database URL has been configured, so the real PostgreSQL route suite has not run. No original SQLite data was imported into the installed PostgreSQL service or production; account mapping was checked only in disposable in-memory PGlite targets.

## SQLite schema mismatch

The inspected SQLite files record only `coin-rate-10k-rc-per-1000-ngn-v1` in `app_migrations`. The SQLite application also creates tables and columns using startup DDL and `ensureColumn`, without recording each schema change in that table. Therefore `campaign_tracking_sessions`, `campaign_tracking_events`, `action_reward_claims`, and `password_reset_tokens` were absent in those valid older snapshots. They are current app features for link tracking, action rewards, and password recovery; no historical rows are fabricated for them.

## Account and data mapping

| SQLite source | PostgreSQL target | Clean-launch import behavior |
|---|---|---|
| `users` | `users` | Copies IDs, names, email addresses, bcrypt password hashes, role, creation timestamp, and zero balance columns. |
| `advertiser_profiles` | `advertiser_profiles` | Copies profile IDs, account relationship, business name, website, review status, and creation timestamp. |
| `platform_settings`, `app_migrations` | Same names | Copies existing platform settings and app migration markers. |
| `campaigns`, `views`, `withdrawals`, `campaign_fundings`, `ledger_entries` | Same names | Not imported in clean-launch mode. Any financial/reward row stops import for review. |
| `support_tickets`, `audit_logs`, `notifications`, `watch_sessions`, tracking/action data, `session_store`, rate-limit rows | Same names | Not imported; their source row counts are reported as reset candidates. Pending or approved action claims and unresolved support tickets block import. |

The SQLite `users` table has `id`, `name`, `email`, `password_hash`, `role`, `balance`, `created_at`, `available_rc`, `pending_rc`, and `legacy_balance_kobo`. These snapshots have no email-verification field, per-account permission field, or account-status field to map; `role` is the only access field present. Both inspected snapshots contain one non-admin account and no admin-role account. Admin access is represented by `role='admin'`; a separate admin account must be provisioned through `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Production startup now refuses to reuse an existing non-admin account as the configured admin. The bcrypt hash column is copied unchanged, so existing password compatibility is retained.

`migrations/001_initial_postgres.sql` defines PostgreSQL integer balances and monetary amounts, identity IDs, foreign keys, uniqueness rules, indexes, and all current feature tables. `scripts/migrate.js` applies the schema version once. `scripts/import-sqlite.js` is explicit and never runs during app startup. It requires an empty target, checks row counts and balance totals, and refuses to proceed if it finds any nonzero legacy/current balance, ledger row, funding row, view, withdrawal, pending/approved action claim, or unresolved support ticket. Rejected funding and completed withdrawal rows also stop import for human review rather than being discarded.

## Inspection of the original SQLite files

Both `rewardhub.db` and `database-backups/rewardhub-local-20261030-161405.sqlite` are 155,648 bytes. They have the same tables and identical row contents in the inspection; each has one user, two campaigns, six platform settings, one app migration, three rate-limit hits, two session rows, and one watch session. Advertiser profiles, audit logs, fundings, ledger entries, notifications, support tickets, views, and withdrawals are empty. The aggregate legacy `balance`, available RC, pending RC, and legacy kobo balances are all zero. No recorded funding, reward, ledger, or withdrawal obligation was found in these snapshots. There is no admin-role account.

To test account mapping, the importer was run read-only against each original file into its own in-memory PGlite database. Each run preserved the sole account's ID, email, bcrypt hash, role, and creation timestamp exactly; all balance, ledger, funding, reward, and withdrawal checks passed. The in-memory targets were disposed at the end of the checks. This did not write to either SQLite file or create an import in the installed PostgreSQL service or any production database. The clean-launch policy would exclude the two campaigns, watch session, rate-limit rows, and session rows; no historical records have been reset in the original files.

## Database and tests on Windows

The existing automated suites are:

```powershell
npm test
npm run test:postgres
```

`npm test` runs the existing full behavior regression suite against a newly created temporary SQLite fixture. It does not open either original database. `npm run test:postgres` uses embedded PGlite and isolated generated fixtures for the PostgreSQL schema/import behavior, fail-closed financial checks, query translation, and rollback. Neither suite substitutes for running against the installed PostgreSQL server.

To create an isolated test database in pgAdmin:

1. Register the local server at host `127.0.0.1`, port `5432`, maintenance database `postgres`, user `postgres`. Enter the PostgreSQL installation password in pgAdmin yourself; it is not needed in chat.
2. Under **Login/Group Roles**, create `rewardhub_test_user`, enable **Can login**, and set a test-only password in pgAdmin's password field.
3. Under **Databases**, create `rewardhub_test` and set its owner to `rewardhub_test_user`.
4. From the repository folder, run `Copy-Item .env.example .env.test.local`, open `.env.test.local`, and set both `DATABASE_URL` and `TEST_DATABASE_URL` to the test role, its password, `127.0.0.1`, port `5432`, and database `rewardhub_test`. Keep this file local and ignored by Git. Do not paste a password into this chat.
5. Run the real PostgreSQL suite:

```powershell
npm run test:postgres:runtime
```

The suite rejects a non-loopback host or database name without `test`. It creates a uniquely named test schema so it cannot alter the database's `public` schema; the exact schema name is printed and the schema is left in place for review. Never use a production URL in `TEST_DATABASE_URL`.

`npm start` also loads `.env.local` and fails clearly if `DATABASE_URL` is missing. Keep local development and test URLs separate. The production configuration must use a separate Render-managed database and unique production secrets.

Latest verification: `npm test` passed 1/1; `npm run test:postgres` passed 6/6; `npm audit` reported 0 vulnerabilities; JavaScript syntax checks passed. The account-preserving importer also passed against both original snapshots in separate in-memory PGlite databases, preserving account fields exactly and passing all balance/financial checks. `npm run test:postgres:runtime` stopped at its guard because `.env.test.local`/`TEST_DATABASE_URL` is not configured. No actual PostgreSQL route, existing-password login, or full process-restart test has passed yet.

## Remaining before deployment

- Configure the dedicated local test database and run `npm run test:postgres:runtime`.
- Verify the account import in that isolated test schema, confirm the copied admin role, and have the account owner perform an existing-password login check. The original password is not required for import and must not be sent in chat.
- Review test results for registration, login/recovery, persistent sessions, advertiser review, campaign/funding flows, view/action reward calculations, withdrawal lifecycle, support, rate limiting, and concurrent requests.
- Validate the Render Blueprint and production-only environment variables after the real PostgreSQL suite passes.
- Do not deploy or automatically import account data into production until the test report is clean and the owner approves the production migration separately.
