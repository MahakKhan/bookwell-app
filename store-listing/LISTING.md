# Bookwell – Shopify App Store listing kit

Copy each block into the matching field of the Partner Dashboard → Distribution → App listing.
Character limits are Shopify's; counts are shown.

## Basics
| Field | Value |
|---|---|
| App name (≤30) | `Bookwell: Booking & Scheduling` (30) |
| Category | Store management → Booking / Scheduling (or "Selling services") |
| App icon | `app-icon-1200.png` (1200×1200) |
| Privacy policy URL | `https://<your-domain>/privacy` |
| Terms URL (optional) | `https://<your-domain>/terms` |
| Support / FAQ URL | `https://<your-domain>/support` |
| Support email | the `SUPPORT_EMAIL` you set on the server |
| Demo store URL | your dev store, with the password page OFF (or the password in the reviewer notes) |
| Languages | English (widget also: Spanish, French, German) |

## App introduction (≤100 chars)
`Take bookings, rentals & classes on your store, with deposits and zero double-bookings.` (87)

## App details (≤500 chars)
```
Bookwell turns any product page into a booking calendar. Sell appointments, group classes, events, hourly rentals, full-day passes and multi-day stays with deposits or full payment through Shopify checkout. Staff schedules, equipment stock, waitlists, packages and waivers are built in. Reminders go out by email, SMS or WhatsApp. Syncs with Google, Outlook, Zoom and Teams. Every feature is on every plan, including Free.
```
(≈ 490)

## Feature list (each ≤80 chars, up to 5 bullets)
1. `Book appointments, classes, rentals & multi-day stays from product pages`
2. `Deposits and prepayment through Shopify checkout, with automatic refunds`
3. `Staff schedules, equipment stock, breaks, holidays and zero double-bookings`
4. `Email, SMS & WhatsApp reminders, QR check-in, waivers and class packs`
5. `Google, Outlook, Zoom & Teams sync, plus a team portal for your staff`

## Screenshots to upload (1600×900 recommended; 3–6)
Capture these from your dev store (browser at 1600×900, Shopify admin visible):
1. **Dashboard**: stats and the week calendar.
2. **Calendar** page, Week view with a few bookings.
3. **Services** → edit a service (payment / capacity sections visible).
4. **Storefront widget** on a product page: month calendar + time slots.
5. **Integrations** card grid.
6. **Billing** plans table.
Add short captions in the dashboard form (e.g. "See every booking at a glance").

## Demo video (optional, 60–90 s outline)
1. Setup guide: create a service, set hours (15 s)
2. Add the widget to a product page with one click (10 s)
3. Customer books on the storefront and pays a deposit (25 s)
4. Booking appears on the Calendar; reminder + QR ticket in the email (20 s)
5. Mention: no double-booking, every feature on every plan (10 s)

## Pricing (enter exactly as in the app)
| Plan | Price / 30 days | Bookings / 30 days | Team members |
|---|---|---|---|
| Free | $0 | 10 | 1 |
| Starter | $9.99 | 75 | 3 |
| Growth | $24.99 | 300 | 3 |
| Pro | $49.99 | 1,000 | 3 |
| Scale | $89.99 | 2,500 | 3 |
| Unlimited | $149.99 | Unlimited | 3 |

Extra team seats: $4.99/month each. 7-day free trial on the first paid plan. Every feature is included on every plan.

## Search terms (up to 5)
`booking`, `appointments`, `scheduling`, `rentals`, `reservations`

---

# Notes for the Shopify reviewer (paste into "Testing instructions")

```
Bookwell lets merchants sell bookings (appointments, classes, rentals).

1. Install the app on the test store. You land on the Setup guide (also in the left menu).
2. Step 2: create a service (e.g. "Haircut", 30 min, $45). Step 3: set working hours
   for the person who performs it (this creates a team member).
3. Step 4: click "Add to product page" (opens the theme editor with the Bookwell block;
   Save) after linking the service to a product (Services → edit → "Link to a product").
   Alternative with no theme changes: open https://<store>.myshopify.com/apps/booking/book
4. On the storefront, open the product (or the booking page), pick a date and time,
   enter any name and email, and confirm. The booking appears in the app under
   Bookings and Calendar. For a paid flow: edit the service → Payment → "Full price up
   front"; booking then redirects to Shopify checkout (use Shopify's test gateway).
5. Cancel/reschedule from the link in the confirmation email or Bookings → open booking.
6. Billing: Billing page → "Start 7-day free trial" opens Shopify's approval screen
   (test charge on development stores).
7. Optional integrations (Google, Zoom, Outlook, HubSpot, Twilio phone, AI) require the
   merchant's own accounts and are inactive until configured; core booking does not
   depend on them.

No account creation or external logins are needed to test the core flow.
Privacy webhooks (customers/data_request, customers/redact, shop/redact) are implemented
at /webhooks/compliance; uninstall cleanup at /webhooks/app/uninstalled.
```

# Why each access scope is requested (answer these in the review form if asked)

| Scope | Used for |
|---|---|
| `read_products`, `write_products` | Merchant picks a product to turn into a bookable service (resource picker); we store the service link on the product as a metafield (`bookwell.service_id`) so the widget shows only on those products; subscription plans for memberships attach to a product. |
| `write_draft_orders` | Creates a Shopify checkout for deposits / prepayment / class packs (draft order invoice) so payment happens on Shopify checkout. |
| `write_orders` | Completes pay-later orders, cancels and refunds orders when a booking is cancelled (merchant opt-in settings), and reads whether an order was cancelled so the booking can be cancelled too. |
| `write_app_proxy` | Storefront booking widget, booking page and customer manage page are served through the app proxy (`/apps/booking`). |
| `read_themes` | Setup guide checks whether the Bookwell block / floating button is added to the live theme. Read-only; the app still works without it. |

Protected customer data (request in Partner Dashboard → API access → Protected customer data):
- **Name, email, phone** (Level 2): shown to the merchant on bookings, used for confirmation/reminder messages the merchant's customer asked for, and for calendar/meeting invites.
- Data is encrypted at rest, access-controlled per shop, deleted on `shop/redact`, and customer-erased on `customers/redact`. See `/privacy`.
- Suggested wording for "How is the data used?": *"Bookwell stores the name, email and phone number a shopper types into the booking form so the merchant can see who booked, send confirmation and reminder messages, and manage the appointment. Data is used only to provide the booking service to that merchant, is never sold or used for advertising, and is deleted on request or when the app is uninstalled."*
