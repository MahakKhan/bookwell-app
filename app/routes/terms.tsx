import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/node";
import { LegalPage, legalConfig } from "../components/LegalPage";

export const meta: MetaFunction = () => [{ title: "Terms of service · Bookwell" }];
export const loader = () => json(legalConfig());

export default function Terms() {
  const { company, email, updated } = useLoaderData<typeof loader>();
  return (
    <LegalPage title="Terms of service" email={email}>
      <p className="muted">Last updated {updated}</p>
      <p>
        These terms apply when a Shopify merchant installs and uses Bookwell, operated by {company} (“we”). By installing the app you agree to them.
        Shopify's own terms and its Partner Program agreement also apply.
      </p>

      <h2>The service</h2>
      <p>Bookwell provides booking management for Shopify stores: services, calendars, team members, customer bookings, payments through Shopify checkout, reminders and optional integrations. Features are described on our App Store listing and may be improved or changed over time.</p>

      <h2>Plans and billing</h2>
      <p>The app has a free plan and paid plans, billed every 30 days through Shopify, with prices shown in the app (Billing page) and the listing. The first paid plan includes a free trial. Plans differ in monthly booking volume and included team members; every feature is included on every plan. You can change or cancel your plan at any time in the app or in Shopify; charges are prorated by Shopify. Uninstalling the app cancels the subscription.</p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>You are responsible for your services, prices, availability, waivers, cancellation rules and for honouring the bookings you accept.</li>
        <li>You are responsible for having a lawful basis to contact and store data about your customers, and for the legal wording of any waiver you use. The waiver template in the app is a starting point, not legal advice.</li>
        <li>You provide and are responsible for your own accounts and keys for connected services (email, SMS, calendar, CRM, phone), including their costs and terms.</li>
        <li>You will not use the app to break the law, send spam, or take bookings for prohibited goods or services.</li>
      </ul>

      <h2>Availability and data</h2>
      <p>We work to keep the app available and to prevent double-bookings, but we do not guarantee uninterrupted service. Please keep your own records of important bookings (the app can export CSV files). How we handle data is described in our <a href="/privacy">privacy policy</a>.</p>

      <h2>Limits of liability</h2>
      <p>The app is provided “as is”. To the extent allowed by law, we are not liable for indirect or consequential losses, lost profits or missed bookings, and our total liability for any claim is limited to the amount you paid us for the app in the three months before the claim.</p>

      <h2>Ending the agreement</h2>
      <p>You can stop at any time by uninstalling the app. We may suspend access if these terms are broken or the app is misused. Your data is deleted as described in the privacy policy.</p>

      <h2>Contact</h2>
      <p>{email ? <a href={`mailto:${email}`}>{email}</a> : "Use the contact details on our Shopify App Store listing."}</p>
    </LegalPage>
  );
}
