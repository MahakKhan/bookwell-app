import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/node";
import { LegalPage, legalConfig } from "../components/LegalPage";

export const meta: MetaFunction = () => [{ title: "Security and incident response · Bookwell" }];
export const loader = () => json(legalConfig());

export default function Security() {
  const { company, email, updated } = useLoaderData<typeof loader>();
  return (
    <LegalPage title="Security and incident response" email={email}>
      <p className="muted">Last updated {updated}</p>
      <p>
        This page describes how {company} protects the personal data that Bookwell handles on behalf of merchants, how access to it is recorded, how
        we prevent its loss, and what we do if something goes wrong. It supplements our <a href="/privacy">privacy policy</a>.
      </p>

      <h2>Protecting the data</h2>
      <ul>
        <li>Data is encrypted in transit (HTTPS/TLS everywhere) and at rest in the database. Keys and tokens that merchants connect (email, SMS, calendar, CRM, webhook) are additionally encrypted with AES-256-GCM.</li>
        <li>Every admin request is authenticated with a Shopify session token. Public booking endpoints are rate limited. Webhooks are verified with Shopify's HMAC signature.</li>
        <li>Only the people who run the service can reach production systems. Access to hosting, database and Shopify accounts uses unique logins with strong passwords and two-step verification where the provider offers it, and is removed when no longer needed.</li>
        <li>We collect only what a booking needs and keep it only as long as the app is installed (see the privacy policy).</li>
      </ul>

      <h2>Access logging</h2>
      <p>
        Whenever a store administrator or staff member opens, searches or exports customers' personal data in the app (the customers list, a customer's
        history, the bookings list and waitlist, and CSV exports), Bookwell records who did it, what kind of access it was, how many records were
        returned and when. The log does not copy the personal data itself. Access logs are kept for 12 months and then deleted automatically, and are
        removed with the store's data when the store is erased.
      </p>

      <h2>Preventing data loss</h2>
      <ul>
        <li>The production database is managed by a provider that keeps encrypted backups and point-in-time restore, so data can be recovered to an earlier moment after an accident or a bad change.</li>
        <li>Database changes are applied through versioned migrations before the new version starts serving traffic, and every release is built and automatically tested before deployment.</li>
        <li>Production and test data are kept apart: test stores and development databases never hold real customers' data.</li>
        <li>Merchants can export their customers and bookings to CSV at any time from the app.</li>
      </ul>

      <h2>Security incident response</h2>
      <p>A security incident is any event that exposes, alters, destroys or makes unavailable personal data without authorisation. If we detect or are told of one:</p>
      <ol>
        <li><b>Contain.</b> The same day we stop the cause: revoke affected keys and sessions, block the access path and, if needed, take the affected feature offline.</li>
        <li><b>Assess.</b> We identify which stores and which kinds of data are affected, using the access logs, hosting logs and database records.</li>
        <li><b>Notify.</b> We tell affected merchants by email without undue delay and in any case within 72 hours of confirming the incident, saying what happened, what data is involved, what we are doing and what they should do. Where the law or Shopify's requirements call for it, we also notify Shopify and the relevant authorities.</li>
        <li><b>Fix and recover.</b> We remove the cause, restore data from backups if necessary and verify that the fix works.</li>
        <li><b>Review.</b> Within two weeks we write up the cause and the changes we are making so it does not happen again.</li>
      </ol>

      <h2>Report a problem</h2>
      <p>
        If you think you have found a security problem, or you believe data has been exposed, email{" "}
        {email ? <a href={`mailto:${email}`}>{email}</a> : "us"} with “Security” in the subject. We respond within one business day.
      </p>
    </LegalPage>
  );
}
