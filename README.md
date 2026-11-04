# RewardHub MVP

> The Express server uses PostgreSQL with persistent PostgreSQL sessions. The installed local PostgreSQL server is running, but no test database URL is configured yet. Do not deploy until `npm run test:postgres:runtime` passes. See [POSTGRES_MIGRATION.md](POSTGRES_MIGRATION.md) for setup and verification status.

A local MVP for sponsored video and 15-second advertiser-link visit reward campaigns, Reward Coin rewards, advertiser funding review, support tickets, and manually reconciled withdrawals.

## Stack and setup

- Node.js 20.12 or newer
- Express 5, PostgreSQL through `pg`, and PostgreSQL-backed express sessions
- PostgreSQL is the application's runtime database; startup fails clearly when `DATABASE_URL` is missing.
- Vanilla HTML, CSS, and JavaScript

### Local PostgreSQL on Windows

Install PostgreSQL Server, Command Line Tools, and optionally pgAdmin using the [official PostgreSQL Windows installer page](https://www.postgresql.org/download/windows/). The official Windows installer is provided by EDB and includes the PostgreSQL server, pgAdmin, and tools such as `psql`.

In pgAdmin, connect to the local server and create a dedicated login role `rewardhub_test_user` and empty database `rewardhub_test`, owned by that role. Choose and enter the test-only password directly in pgAdmin.

Copy `.env.example` to `.env.local`, replace the placeholders with local values, and keep `.env.local` uncommitted. The start command loads this file if present:

```powershell
Copy-Item .env.example .env.local
npm install
npm start
```

Open `http://localhost:3000`. Set `DATABASE_URL=postgres://rewardhub_test_user:YOUR_LOCAL_TEST_PASSWORD@127.0.0.1:5432/rewardhub_test`, a random `SESSION_SECRET` of at least 32 characters, and the existing product secrets in `.env.local`. Use a separate Render-managed database and secret values in production.

`npm test` runs the behavior regression suite against a temporary SQLite fixture. `npm run test:postgres` runs schema/import tests against embedded PGlite fixtures. To run the same route workflows against the real local PostgreSQL server, set `TEST_DATABASE_URL` in an ignored `.env.test.local` file and run `npm run test:postgres:runtime`. That suite uses a unique schema in a loopback database whose name includes `test`.

Create the ignored runtime-test settings file with `Copy-Item .env.example .env.test.local`, then set both `DATABASE_URL` and `TEST_DATABASE_URL` to the local `rewardhub_test` connection string. The runtime suite prints its unique schema name and leaves that test schema in place for review.

## Admin account and secrets

An administrator is provisioned only if both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are configured. The initial password is hashed with bcrypt; an existing admin account is left unchanged. Production startup stops if the configured admin email already belongs to a non-admin account, rather than changing that account's role. For production, use HTTPS, `NODE_ENV=production`, a unique session secret of at least 32 characters, and an admin password of at least 12 characters. Keep secrets in `.env.local` only for local development and in the hosting provider's secret manager in production.

Password recovery uses Resend. Configure `RESEND_API_KEY`, a verified `EMAIL_FROM` sender, and `APP_BASE_URL` (the public HTTPS origin without a trailing slash). Recovery links are single-use, expire after 30 minutes, and invalidate existing sessions for that account.

## PostgreSQL migration and clean launch

The PostgreSQL schema is versioned in `migrations/` and applied at app startup. The account-preserving importer keeps user IDs, emails, bcrypt hashes, roles, creation timestamps, advertiser profiles, and platform settings. It refuses to import when it finds a nonzero legacy/current balance, ledger, funding, view, withdrawal, pending/approved action claim, or unresolved support ticket. It leaves old campaigns and activity empty. It must only be run manually against a newly created, isolated database after financial records have been classified. Its account mapping was checked against both local SQLite files in disposable in-memory PostgreSQL tests; no persistent PostgreSQL or production database received an import.

Both local SQLite files are retained as read-only backups. Do not run the importer against production as part of application startup. See [POSTGRES_MIGRATION.md](POSTGRES_MIGRATION.md) for mapping, reset rules, and verification status.

## Deployment status

`render.yaml` provides a Blueprint for a Node web service and a separate managed PostgreSQL database. Set required secret values in the Render Dashboard and complete local PostgreSQL route/session/financial/concurrency tests before creating or deploying the Blueprint. No deployment is performed by this project setup.

## Current product behavior

- User and advertiser accounts are separate. Advertiser profiles require administrator approval before campaign submission.
- Campaigns support qualifying video views and optional, capped advertiser-link visit rewards. For an action reward, the viewer opens the advertiser's existing website, WhatsApp, or social link from Reward Hub; the reward is credited after the opened tab remains available for 15 seconds. Advertisers do not install scripts, add an API, edit their project, or redeploy. This timer measures elapsed open-tab time only; it cannot confirm that someone read a page, registered, submitted a form, or sent a message.
- Campaign ads play without native pause, seek, or replay controls and attempt to autoplay. If the browser blocks autoplay, the viewer gets a Start ad button. Tapping anywhere on the video surface opens the advertiser destination in a new tab. A close X appears during the final second and remains available at the end; tapping it submits the completion for the server's normal checks and returns to the dashboard without opening the advertiser.
- A submitted completion is a single attempt and must pass a server elapsed-time check, then remains pending until manual review. Elapsed time does not prove genuine playback or attention.
- Campaigns require administrator approval and full advertiser funding reconciliation before they appear to users. Advertiser transfer references are claims, not proof of payment.
- Current defaults are 10,000 RC = ₦1,000, 25 RC (₦2.50) per qualifying view, a 40,000 RC (₦4,000) minimum withdrawal, and a 40% viewer reward pool / 50% platform allocation / 10% operating reserve split for new campaigns. Admins can configure the default view reward. The conversion is shown to users only while preparing a withdrawal. Each campaign stores its allocation snapshot. The operating reserve and platform allocation are reporting buckets, not automatic transfers. Both view and action rewards use the same capped viewer pool. Actual operating expenses are recorded in the ledger, separately from viewer balances and withdrawals. Reward Hub records link clicks and credits an action reward after the viewer keeps the opened tab available for 15 seconds. This does not verify activity inside the advertiser site.
- Bank withdrawals are disabled until `BANK_DETAILS_ENCRYPTION_KEY` is configured as a strong secret. The initial manual payout flow reserves RC, records each review state, and requires payout reference and evidence before marking paid.
- Withdrawals are manual: users submit bank details, RC is reserved, and an administrator reviews the request, pays it from the business bank account, then records payout reference and evidence. Requests are accepted only when bank-detail encryption is configured. The app does not require Paystack or an automated payout provider for this workflow.
- Advertiser funding instructions are hidden until `ADVERTISER_FUNDING_INSTRUCTIONS` is configured with verified business payment details. The app does not connect to a payment provider or verify bank transfers automatically.
- Administrators can also enter a campaign for an advertiser who does not want a Reward Hub account. The administrator enters the business name, video, destination link, budget, and reward terms in the admin Campaigns tab. The advertiser pays the administrator outside Reward Hub; the administrator records each deposit in the Funding tab only after independently confirming it in the bank account. Each deposit requires a unique bank statement reference and verification note, is limited to the campaign's remaining budget, and is written to both the funding table and ledger. Campaign approval and full recorded funding are both required before it can go live. The app does not receive, hold, split, or automatically pay advertiser money. Keep bank details out of source code; set any advertiser-facing payment instructions in deployment environment configuration and communicate payment terms directly to guest advertisers.
- The app has restricted legacy reconciliation handling for historical financial rows, but clean-launch imports refuse any nonzero balance or financial activity and do not import those rows. Historical withdrawal destinations are not returned by the application APIs.
- Support tickets and an audit trail are stored in the local database. Password reset is implemented but requires Resend configuration. Identity checks, bank ownership verification, automated funding, and automated payouts are not configured.

## Before a real-money launch

Before public real-money use, configure account recovery email and verified business funding instructions; secure the business bank account and payout encryption key; establish reconciliation and support operations; test backups and restore; integrate trusted campaign measurement; and obtain jurisdiction-specific legal, privacy, tax, and advertiser terms review. The withdrawal workflow is deliberately manual: the platform administrator initiates each bank transfer outside RewardHub and records it after checking the bank's confirmation. RewardHub itself does not move money.
