# Bookwell

Shopify appointment-booking app. Remix admin (Polaris) + Prisma + a
Theme App Extension for the storefront widget.

## What's built so far

- **Admin**: Dashboard, Services, Staff, Settings (`app/routes/app.*`)
- **Data model**: `prisma/schema.prisma` — Shop, Service, StaffMember,
  Location, AvailabilityRule, Booking, BillingReconciliation
- **Booking engine**: `app/models/booking.server.ts` — double-booking
  prevention (DB-level unique index + serializable transaction) and a
  single `getOpenSlots` function shared by the admin calendar, the
  storefront widget, and (eventually) the POS extension
- **Billing integrity**: `app/models/billing.server.ts` — a
  reconciliation job stub that compares Shopify's real subscription
  status against what the app expects, meant to run weekly
- **Billing API**: now working end-to-end. The earlier persistent 403
  ("GraphQL Client: Forbidden") had nothing to do with app distribution,
  business registration, or protected customer data — it was that
  `@shopify/shopify-app-remix` 3.8.5 issued legacy *non-expiring* offline
  access tokens, which Shopify's Admin API rejects outright for any app
  created after April 2026. Fixed by upgrading to
  `@shopify/shopify-app-remix@6` / `@shopify/shopify-api@15` and adding
  `future: { expiringOfflineAccessTokens: true }` in `shopify.server.ts`
  (this also needs `Session.refreshToken` / `refreshTokenExpires`
  columns — see `prisma/schema.prisma`). If you ever see this 403 again
  on a *different* Shopify app, check `Session.expires` in the database
  first — `null` means you're still on a non-expiring token.
- **Storefront widget**: `extensions/booking-widget/` — a Theme App
  Extension block that only renders (and only loads its JS/CSS) on
  products with a `bookwell.service_id` metafield, so it never touches
  non-bookable product pages. Real staff picker (auto-skipped when
  there's only one), and widget text is localized (en/es/fr/de, picked
  from the storefront's own active language) — see
  `extensions/booking-widget/assets/booking.js`
- **Service buffer time**: `Service.bufferMinutes` is enforced in both
  slot generation (`availability.tsx`) and booking creation
  (`bookings.tsx`) — a service's effective blocked time is
  `durationMinutes + bufferMinutes`
- **Customer self-service**: `app/routes/manage.tsx` — reschedule or
  cancel a booking via a token-authenticated link (`Booking.manageToken`,
  no account needed), linked from the widget's confirmation screen.
  Also localized en/es/fr/de based on `Accept-Language` / `Shop.locale`
- **Notifications**: `app/models/notify.server.ts` — booking
  confirmation email (Resend) and SMS (Twilio), bring-your-own API keys
  entered on the Settings page; no-ops silently if unconfigured
- **Calendar sync**: `app/models/calendar.server.ts` +
  `app/routes/app.calendar.connect.tsx` / `app.calendar.callback.tsx` —
  Google Calendar OAuth, creates/updates/deletes a calendar event on
  booking/reschedule/cancel. Requires your own `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` (see below)
- **POS extension**: `extensions/bookwell-pos/` — a Smart Grid tile +
  modal listing the rest of today's bookings, reading from the same
  `getOpenSlots`/`Booking` data as everything else via
  `app/routes/api.pos.bookings.tsx`. Set `APP_URL` in
  `extensions/bookwell-pos/src/Modal.jsx` to your real deployed app URL
  before shipping (a POS extension can't read the server's env vars,
  and the dev tunnel URL isn't stable across restarts) — can only be
  exercised in the real Shopify POS app/simulator, not in a browser
- **Webhooks**: app/uninstalled, billing update, orders/paid

## Not built yet (next steps)

- Outlook / Apple calendar sync — only Google is wired up so far;
  `calendar.server.ts` is the place to add the equivalent OAuth flows
- Reminder messages sent *before* an appointment (only the booking-time
  confirmation sends today) — needs a scheduler/cron, which a plain
  Remix dev server doesn't have
- Real hosting — this only runs via `shopify app dev` on a local
  machine right now. See "Deploying" below.
- App Store submission — the listing checklist (icon, contact email,
  primary language, protected customer data questionnaire) is still
  incomplete in the Partner Dashboard

## Email / SMS / Calendar: bring your own provider

None of these are required to use the app — everything else works with
all of them left blank.

- **Email**: create a free [Resend](https://resend.com) account, verify
  a sending domain, and paste the API key + from-address into
  Settings → "Email & SMS providers".
- **SMS**: create a [Twilio](https://www.twilio.com) account, buy a
  number, and paste the Account SID / Auth Token / from-number into the
  same Settings section.
- **Google Calendar**: create an OAuth client in
  [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
  (APIs & Services → Credentials → OAuth client ID → Web application),
  add `<your app URL>/app/calendar/callback` as an authorized redirect
  URI, enable the Google Calendar API for that project, then set
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Restart
  `shopify app dev`, then click "Connect Google Calendar" on the
  Settings page.

## Local setup

1. Install the Shopify CLI if you don't have it, then from this
   folder run:
   ```bash
   npm install
   shopify app config link
   ```
   This fills in `client_id` and the URLs in `shopify.app.toml` for a
   real app registered in your Partner Dashboard.
2. Copy `.env.example` to `.env` — `shopify app config link` and
   `shopify app dev` fill most of it in for you.
3. Set up the database:
   ```bash
   npx prisma migrate dev --name init
   ```
4. Run the app against a dev store:
   ```bash
   npm run dev
   ```
   This tunnels your local server, installs the app on your dev
   store, and watches for changes.
5. On a product in your dev store, add the metafield
   `bookwell.service_id` (namespace `bookwell`, key `service_id`,
   type single line text) with a value matching a Service's id from
   the admin, then add the "Bookwell booking" block to that product
   template in the theme editor.

## Deploying

Swap `DATABASE_URL` for a real Postgres instance, run
`npx prisma migrate deploy`, then `shopify app deploy` to push the
extension and app configuration, and host the Remix server (Fly.io,
Render, Railway, etc. all work with this template).
