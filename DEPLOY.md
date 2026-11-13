# Deploying Bookwell for the App Store

## 0. Before you start
- A **Render** account (paid *Starter* plan or higher: free instances sleep and break webhooks/jobs).
- A **production Postgres** that is NOT your dev data. Neon works. Create it in the **same region as the Render service** (Oregon / `us-west-2` in `render.yaml`); a distant database makes every request ~10× slower.
- Your support email (shown on `/support`, `/privacy`, `/terms`).

## 1. Push the code
```bash
git add -A && git commit -m "Prepare for App Store submission" && git push
```

## 2. Create the Render service
Render → **New → Blueprint** → choose the `bookwell-app` repo. It reads `render.yaml`. Fill in the prompted values:

| Variable | Value |
|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Partner Dashboard → your app → Client credentials |
| `DATABASE_URL` | production Postgres connection string (`?sslmode=require`) |
| `ENCRYPTION_KEY` | a long random string; **never change it later** (it decrypts stored API keys) |
| `SUPPORT_EMAIL` | your support address |
| `SHOPIFY_APP_URL` | the service URL, e.g. `https://bookwell-app.onrender.com` |
| `BILLING_LIVE` | leave `false` until step 6 |
| Optional: `ANTHROPIC_API_KEY`, `GOOGLE_*`, `ZOOM_*`, `MS_*` | enable those features (see README) |

The start command runs `prisma migrate deploy`, so the database schema is created on first boot. Check `https://<service>/healthz` returns `ok`.

## 3. Point Shopify at it
`shopify.app.toml` already uses `https://bookwell-app.onrender.com`; change it if your URL differs, then:
```bash
npx shopify app deploy
```
This publishes the app configuration (URLs, scopes, webhooks, app proxy), the theme extension (widget + floating button) and the POS extension.

## 4. Partner Dashboard checklist
1. **Protected customer data**: App → API access → *Protected customer data* → request access for **name, email, phone**; paste the wording from `store-listing/LISTING.md`.
2. **Listing**: Distribution → *Create listing*. Use `store-listing/LISTING.md` (copy, icon, pricing, reviewer notes). URLs: `/privacy`, `/terms`, `/support` on your domain. Add 3–6 screenshots + optional demo video.
3. **Pricing**: pricing is charged by the app through Shopify billing; describe the plans in the listing as in LISTING.md.

## 5. Test on a clean dev store (do this before submitting)
Create a fresh development store, install via the app's install link, then walk `store-listing/LISTING.md` → "Notes for the Shopify reviewer". Confirm: setup guide, a free booking, a deposit booking (test gateway), cancel + refund, reschedule from the email link, the plan approval screen, uninstall (check the app disappears and data stays until `shop/redact`).

## 6. Go live
- Set `BILLING_LIVE=true` on Render and redeploy.
- Submit the app for review from the Partner Dashboard.

## Operations
- **Background jobs** (payment confirmation, reminders, calendar sync) run inside the web service every few minutes. Keep the plan always-on. An external ping of `POST /api/reminders/send` with header `X-Cron-Secret: <CRON_SECRET>` is a safe extra trigger.
- **Backups**: enable your database provider's point-in-time backups.
- **Tests**: `npm test` (unit); `npm run test:db` runs the booking-engine tests against `DATABASE_URL` (use a test database).
- **Known dev-only advisories**: `npm audit` findings are in build tooling (Remix dev, Vite, Shopify CLI). They are not shipped to production; upgrade when Remix 3 / the next Shopify template is adopted.
