# RewardHub MVP

A local MVP for sponsored video campaigns, Reward Coin rewards, advertiser funding review, support tickets, and manually reconciled withdrawals.

## Stack and setup

- Node.js 20 or newer
- Express, bcryptjs, express-session
- SQLite (`better-sqlite3` when its native binding is available; Node's built-in `node:sqlite` fallback on Node 22.5+)
- Vanilla HTML, CSS, and JavaScript

From this directory, run:

```powershell
npm install
npm start
```

Open `http://localhost:3000` (or the port configured with `PORT`). Run the integration suite with `npm test`.

## Admin account and secrets

An administrator is provisioned only when both credentials are configured. Set them before the first run:

```powershell
$env:ADMIN_EMAIL="your@email.com"
$env:ADMIN_PASSWORD="a-long-unique-password"
$env:SESSION_SECRET="generate-a-random-secret-at-least-32-characters"
$env:NODE_ENV="development"
npm start
```

For production, use HTTPS, `NODE_ENV=production`, a unique session secret of at least 32 characters, and an admin password of at least 12 characters. Store secrets in the deployment secret manager, not in source control. Back up the SQLite database and secrets securely; rotate keys only with a planned data re-encryption procedure.

Password recovery now uses Resend. Configure `RESEND_API_KEY`, `EMAIL_FROM` (a sender verified with Resend), and `APP_BASE_URL` (the public HTTPS origin, without a trailing slash). Recovery links are single-use, expire after 30 minutes, and invalidate existing sessions for that account. Without these email settings, recovery endpoints remain unavailable.

## Current product behavior

- User and advertiser accounts are separate. Advertiser profiles require administrator approval before campaign submission.
- The MVP supports video visibility campaigns only. Other objectives are intentionally unavailable until reliable measurement is integrated.
- A submitted completion is a single attempt and must pass a server elapsed-time check, then remains pending until manual review. Elapsed time does not prove genuine playback or attention.
- Campaigns require administrator approval and full advertiser funding reconciliation before they appear to users. Advertiser transfer references are claims, not proof of payment.
- Current defaults are 10,000 RC = ₦1,000, a 20,000 RC (₦2,000) minimum withdrawal, 0% withdrawal fee, 50% reward allocation, and 20% variable-cost estimate. Administrators can change settings for future requests. Existing installations on the prior default rate are migrated once; custom values are preserved.
- Bank withdrawals are disabled until `BANK_DETAILS_ENCRYPTION_KEY` is configured as a strong secret. The initial manual payout flow reserves RC, records each review state, and requires payout reference and evidence before marking paid.
- Withdrawals are manual: users submit bank details, RC is reserved, and an administrator reviews the request, pays it from the business bank account, then records payout reference and evidence. Requests are accepted only when bank-detail encryption is configured. The app does not require Paystack or an automated payout provider for this workflow.
- Advertiser funding instructions are hidden until `ADVERTISER_FUNDING_INSTRUCTIONS` is configured with verified business payment details. The app does not connect to a payment provider or verify bank transfers automatically.
- Existing balances and old completions are preserved in a restricted legacy reconciliation state. They are not converted into spendable RC automatically. Historical withdrawal destinations are not returned by the application APIs.
- Support tickets and an audit trail are stored in the local database. Password reset is implemented but requires Resend configuration. Identity checks, bank ownership verification, automated funding, and automated payouts are not configured.

## Before a real-money launch

Before public real-money use, configure account recovery email and verified business funding instructions; secure the business bank account and payout encryption key; establish reconciliation and support operations; test backups and restore; integrate trusted campaign measurement; and obtain jurisdiction-specific legal, privacy, tax, and advertiser terms review. The withdrawal workflow is deliberately manual: the platform administrator initiates each bank transfer outside RewardHub and records it after checking the bank's confirmation. RewardHub itself does not move money.
