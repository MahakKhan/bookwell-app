import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/node";
import { LegalPage, legalConfig } from "../components/LegalPage";

export const meta: MetaFunction = () => [{ title: "Support · Bookwell" }];
export const loader = () => json(legalConfig());

const FAQ: [string, string][] = [
  ["How do I add the booking calendar to my store?", "Open Bookwell → Setup guide → step 4. One click opens your theme editor with the Bookwell block on your product page; you can also turn on the floating “Book now” button, or share your booking page link (yourstore.com/apps/booking/book)."],
  ["Customers see “No open times”. Why?", "Check that your service has at least one active team member with working hours (Team page), or its own opening hours if it has no team member. The Dashboard warns you when a service can't be booked and tells you why."],
  ["How do deposits and prepayment work?", "Set “Payment” on the service. The customer pays through Shopify checkout; the slot is held while they pay and released if they don't finish."],
  ["Can I cancel or refund a booking?", "Yes: Bookings → open the booking → Cancel. Under Settings → Orders & refunds you can have the Shopify order cancelled and refunded automatically."],
  ["Will I get double-booked?", "No. Bookings are checked under a lock in the database, on every plan. Website, POS, phone and manual bookings all use the same calendar."],
  ["How do I delete a customer's data?", "Customers → open the customer → Delete. Shopify's customer privacy requests are also handled automatically."],
  ["How do I change plans or cancel?", "Billing page in the app, or Shopify admin → Settings → Apps. Uninstalling cancels the subscription."],
];

export default function Support() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <LegalPage title="Bookwell support" email={email}>
      <div className="card">
        <b>Need help?</b>
        <p style={{ margin: "6px 0 0" }}>
          {email ? (
            <>
              Email <a href={`mailto:${email}`}>{email}</a>. Include your store address (yourstore.myshopify.com) and, if possible, a screenshot. We reply within one business day.
            </>
          ) : (
            "Contact us through the support details on our Shopify App Store listing."
          )}
        </p>
      </div>
      <h2>Common questions</h2>
      {FAQ.map(([q, a]) => (
        <div key={q}>
          <p style={{ margin: "14px 0 2px" }}>
            <b>{q}</b>
          </p>
          <p style={{ margin: 0 }}>{a}</p>
        </div>
      ))}
      <h2>Policies</h2>
      <p>
        <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of service</a>
      </p>
    </LegalPage>
  );
}
