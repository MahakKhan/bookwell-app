import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/node";
import { LegalPage, legalConfig } from "../components/LegalPage";

export const meta: MetaFunction = () => [{ title: "Privacy policy · Bookwell" }];
export const loader = () => json(legalConfig());

export default function Privacy() {
  const { company, email, updated } = useLoaderData<typeof loader>();
  return (
    <LegalPage title="Privacy policy" email={email}>
      <p className="muted">Last updated {updated}</p>
      <p>
        Bookwell (“the app”, operated by {company}) is a Shopify app that lets stores take appointment and rental bookings. This policy explains what
        data the app handles, why, who sees it, and how long it is kept. It covers two groups of people: <b>merchants</b> who install the app, and
        <b> customers</b> who book with a merchant's store.
      </p>

      <h2>Who is responsible for the data</h2>
      <p>
        For their customers' data, the merchant is the data controller and {company} is the processor: we store and process booking data only to run
        the app for the merchant, on their instructions. For merchant account data (the store itself), {company} is the controller.
      </p>

      <h2>What we collect</h2>
      <table>
        <thead>
          <tr><th>Whose</th><th>Data</th><th>Why</th></tr>
        </thead>
        <tbody>
          <tr><td>Merchant</td><td>Store domain, Shopify access token, plan, timezone, settings, team members' names, emails and working hours, services and prices</td><td>To operate the app and bill through Shopify</td></tr>
          <tr><td>Customer</td><td>Name, email, phone number (optional), the booking (service, time, quantity, price, payment status), answers to the merchant's booking questions, notes</td><td>To make, change, remind about and cancel bookings</td></tr>
          <tr><td>Customer</td><td>If the service has a waiver: the signed name, drawn signature image, the text signed, time, IP address and browser type</td><td>To keep a record of the signed waiver for the merchant</td></tr>
          <tr><td>Customer</td><td>If the merchant switches on the phone receptionist: caller phone number and a transcript of the call</td><td>To take bookings by phone and show the merchant what was said</td></tr>
          <tr><td>Both</td><td>A log of emails, texts and integration events sent (recipient and delivery status)</td><td>To show delivery history and troubleshoot</td></tr>
        </tbody>
      </table>
      <p>We do not collect payment card details. Payments happen on Shopify's checkout. We do not sell personal data, and we do not use it for advertising.</p>

      <h2>Who else receives it</h2>
      <p>The app shares data only with the services needed to run it:</p>
      <ul>
        <li><b>Shopify</b>: checkout, orders, products and billing.</li>
        <li><b>Our hosting and database providers</b>, which store the data on our behalf.</li>
        <li><b>Services the merchant chooses to connect</b>, using the merchant's own accounts and keys: Resend (email), Twilio (SMS, WhatsApp and phone calls), Google Calendar and Meet, Microsoft Outlook and Teams, Zoom, HubSpot, Klaviyo, Google Analytics, Meta Pixel, and any webhook endpoint or Zapier hook the merchant sets up. Each receives only what its feature needs (for example, a calendar event with the booking time and customer name).</li>
        <li><b>Anthropic</b>, which processes text for the optional AI features (AI service builder and phone receptionist). For the phone receptionist this includes what the caller says. Anthropic does not use API inputs to train its models.</li>
      </ul>

      <h2>Storage, security and retention</h2>
      <ul>
        <li>Data is stored in an encrypted database. Merchant-provided secrets (email, SMS, calendar, CRM and webhook keys) are additionally encrypted with AES-256-GCM, and public booking endpoints are rate limited.</li>
        <li>Booking data is kept while the app is installed. When a merchant uninstalls, their connections and keys are deleted immediately, and Shopify's shop-erasure request (about 48 hours later) deletes all of the store's data.</li>
        <li>When Shopify forwards a customer erasure request, we delete that customer's contact record, waiver signatures, call transcripts, waitlist entries and message logs, and anonymise their bookings.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Customers can ask the store they booked with to access, correct, export or delete their data; the merchant can do this in the app and through
        Shopify's customer privacy requests. If you are a customer and contact us instead, we will pass your request to the merchant or action it on
        their behalf. Merchants can export their data (CSV) or ask us to delete it at any time. Depending on where you live (for example under the GDPR
        or CCPA) you may also have the right to complain to your data protection authority.
      </p>

      <h2>Cookies</h2>
      <p>The merchant admin uses only the cookies and storage Shopify's embedded apps need to keep you signed in. The booking widget on a store sets no tracking cookies; if the merchant enables Google Analytics or Meta Pixel, those services' own policies apply to the conversion event we send.</p>

      <h2>Changes and contact</h2>
      <p>
        We will update this page when the app's data handling changes. Questions or requests:{" "}
        {email ? <a href={`mailto:${email}`}>{email}</a> : "use the contact details on our Shopify App Store listing"}.
      </p>
    </LegalPage>
  );
}
