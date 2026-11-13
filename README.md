# Bookwell

Shopify appointment-booking app. Remix admin (Polaris) + Prisma + a
Theme App Extension for the storefront widget.

## What's built so far

- **Admin**: Dashboard, Bookings (list + cancel), Services (link to a product,
  buffer, activate/delete), Staff (editable weekly working hours), Billing,
  Settings (`app/routes/app.*`)
- **Data model**: `prisma/schema.prisma` — Shop, Service, StaffMember,
  Location, AvailabilityRule, Booking, BillingReconciliation
- **Booking engine**: `app/models/booking.server.ts` — double-booking
  prevention (serializable transaction + a partial unique index on
  confirmed bookings, so cancelled slots can be re-booked), slot
  validation (working hours, no past times, active staff/service) and a
  single `getOpenSlots` shared by the storefront widget and manage page.
  All availability maths happens in the **shop's timezone**
  (`app/models/time.server.ts`), which is synced from Shopify on first
  admin load and editable in Settings.
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
- **Webhooks**: app/uninstalled, billing update, the three mandatory
  privacy webhooks (`webhooks.compliance.tsx`). orders/paid has a route
  but is deliberately not subscribed (needs Protected Customer Data).
- **Security notes**: storefront endpoints verify the app-proxy signature
  and scope every lookup to the calling shop; provider keys are encrypted
  at rest and never sent back to the browser; the Google OAuth `state` is
  HMAC-signed; the cron endpoint takes its secret in a header only.
- **Plans**: Free = 1 service + 1 team member. Entry ($9) = unlimited +
  Google Calendar sync. Growth ($19) = + SMS. Charges are Shopify TEST
  charges unless `BILLING_LIVE=true`.

## Not built yet (next steps)

- Outlook / Apple calendar sync — only Google is wired up so far;
  `calendar.server.ts` is the place to add the equivalent OAuth flows
- Anything scheduling-related in-process: reminders only go out when an
  external cron calls `POST /api/reminders/send` (header `X-Cron-Secret`)
  every ~15 minutes
- Service capacity (group bookings), deposits and multiple locations exist
  in the schema but are not wired into the UI or booking flow
- Editing an existing service/staff member's details (delete and re-add)
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
  add `<your app URL>/oauth/google/callback` as an authorized redirect
  URI, enable the Google Calendar API for that project, then set
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Restart
  `shopify app dev`, then click "Connect Google Calendar" in
  Integrations. This also enables Google Meet links and
  blocking times that are busy in Google Calendar.
- **Zoom**: in the [Zoom App Marketplace](https://marketplace.zoom.us/develop/create)
  create a "General app" (user-managed OAuth), add the scopes
  `meeting:write:meeting` and `meeting:update:meeting` / `meeting:delete:meeting`,
  set the redirect URL to `<your app URL>/oauth/zoom/callback`, then set
  `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` in `.env` and click
  "Connect Zoom" in Integrations. Virtual services set to
  "A new Zoom meeting for every booking" then get their own meeting.
- **Outlook Calendar + Microsoft Teams**: in the [Azure portal](https://portal.azure.com) → App registrations → New registration
  (any organisational directory and personal Microsoft accounts), add the web redirect URI
  `<your app URL>/oauth/microsoft/callback`, create a client secret, and add the delegated Microsoft Graph
  permissions `offline_access`, `User.Read`, `Calendars.ReadWrite`. Set `MS_CLIENT_ID` / `MS_CLIENT_SECRET`,
  then connect in Integrations. Teams links need a work or school Microsoft 365 account.
- **Apple Calendar**: Integrations → Apple Calendar → "Create calendar feed" gives a private `.ics` link to
  subscribe to (Calendar → File → New Calendar Subscription). Customers get "Add to calendar" links in emails.
- **HubSpot**: create a private app with `crm.objects.contacts.read/write` and paste its token in Integrations.
- **Zapier**: use a "Webhooks by Zapier → Catch Hook" trigger URL as the webhook (Integrations → Zapier), and
  the Public API for actions.
- **AI phone receptionist**: needs `ANTHROPIC_API_KEY`, your Twilio Account SID / Auth Token (Settings → Email & SMS)
  and a Twilio phone number whose "A call comes in" webhook (HTTP POST) is the URL shown in Integrations.
- **Waivers**: Integrations → Waivers (or `/app/waivers`).
- **Mobile app**: the team portal (`/portal/<token>`) installs on phones as an app (Install app / Add to Home Screen).
- **AI service creation**: set `ANTHROPIC_API_KEY` (from
  [console.anthropic.com](https://console.anthropic.com)) to enable
  "Create your service with AI" in My services → New service. It uses
  Claude Opus 5.5 with a refusal fallback; each service drafted costs a
  few cents.
- **Auto-renewing memberships** (Packages → "Auto-renew"): first request
  *Subscription API* access for the app in the Partner Dashboard; once
  approved, add `read_own_subscription_contracts,write_own_subscription_contracts`
  to `scopes` in `shopify.app.toml` and `SCOPES` in `.env`. Also needs
  Shopify Payments (test mode works on dev stores) and, in the Partner
  Dashboard, *API access → Protected customer data* with **name** and
  **email** selected, so Bookwell can read who subscribed. Link a product
  to the package; Bookwell attaches a subscription selling plan to it,
  bills renewals itself every period, and emails customers a manage /
  cancel link.

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
3. Set up the database (Postgres only; use a separate DB from production):
   ```bash
   npx prisma migrate deploy
   ```
4. Run the app against a dev store:
   ```bash
   npm run dev
   ```
   This tunnels your local server, installs the app on your dev
   store, and watches for changes.
5. In the app's Services page, add a service and click "Link to a
   product" (this sets the `bookwell.service_id` product metafield for
   you). Then add the "Bookwell booking" app block to the product
   template in the theme editor (Online Store > Customize > product
   page > Add block > Apps). Add a team member on the Staff page too.

## Deploying

Swap `DATABASE_URL` for a real Postgres instance, run
`npx prisma migrate deploy`, then `shopify app deploy` to push the
extension and app configuration, and host the Remix server (Fly.io,
Render, Railway, etc. all work with this template).
