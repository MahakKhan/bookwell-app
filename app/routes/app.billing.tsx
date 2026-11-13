import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { authenticate, BILLING_IS_TEST } from "../shopify.server";
import { getShop } from "../models/shop.server";
import { cancelSubscription, createSubscription, syncPlanFromShopify, usageFor } from "../models/billing.server";
import { PLANS, SEAT_PRICE, TRIAL_DAYS, nextPlan, subscriptionPrice } from "../plans";
import { Flash, useBusy } from "../components/ui";

const appUrl = () => (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  // Shopify is the source of truth: re-sync the plan on every visit.
  const { shop, sub } = await syncPlanFromShopify(admin, await getShop(session.shop));
  const u = await usageFor(shop);
  return json({
    isTest: BILLING_IS_TEST,
    trialAvailable: !shop.trialUsed,
    subscription: sub ? { id: sub.id, name: sub.name, test: sub.test, trialDays: sub.trialDays } : null,
    current: u.plan.key,
    extraSeats: u.extraSeats,
    used: u.used,
    limit: u.limit,
    hardLimit: u.hardLimit,
    resets: u.cycleEnd.toISOString(),
    seatsUsed: u.seatsUsed,
    seatsAllowed: u.seatsAllowed,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin, redirect } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "cancel") {
      const id = String(form.get("subscriptionId") || "");
      if (id) await cancelSubscription(admin, id);
      await syncPlanFromShopify(admin, shop);
      return json({ ok: "Your subscription was cancelled. You're on the Free plan now." });
    }
    if (intent === "subscribe") {
      const plan = PLANS.find((p) => p.key === form.get("plan"));
      if (!plan) return json({ error: "Unknown plan." }, { status: 400 });
      const seats = Math.max(0, Math.min(50, Math.round(Number(form.get("extraSeats")) || 0)));
      if (plan.price === 0) {
        const id = String(form.get("subscriptionId") || "");
        if (id) await cancelSubscription(admin, id);
        await syncPlanFromShopify(admin, shop);
        return json({ ok: "You're on the Free plan now." });
      }
      const url = await createSubscription(admin, shop, plan, seats, `${appUrl()}/app/billing`, BILLING_IS_TEST);
      // Shopify's charge approval page can't open inside the admin iframe.
      return redirect(url, { target: "_top" });
    }
  } catch (e) {
    if (e instanceof Response) throw e;
    return json({ error: (e as Error).message }, { status: 400 });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const FEATURES = [
  "Unlimited services, add-ons and booking questions",
  "Group, event, rental, full-day and multi-day bookings",
  "Deposits and prepayment through Shopify checkout",
  "Class packs and memberships",
  "Waitlist and abandoned-checkout recovery",
  "Email, SMS and WhatsApp confirmations and reminders",
  "Google Calendar two-way sync and Google Meet links",
  "Equipment and resource stock",
  "QR tickets and check-in",
  "Team portal",
  "Customers list and CSV export",
  "Public API, webhooks and Klaviyo",
  "Point of Sale (POS)",
  "Double-booking protection",
];
const FAQ: [string, string][] = [
  [
    "What counts as a booking?",
    "Bookings your customers make (online, through POS, the API or the team portal) in the current 30-day cycle. Cancelled and abandoned bookings don't count, and bookings you add by hand never count.",
  ],
  [
    "What happens if I reach my limit?",
    "Nothing stops straight away: bookings keep coming in up to 20% over your limit and we email you. After that, online booking pauses until you upgrade or the cycle resets. Your existing bookings are never affected.",
  ],
  ["Are all features included on every plan?", "Yes. Plans only differ in monthly bookings and included team members. Every feature is on every plan, including Free."],
  ["How does the free trial work?", `Your first paid plan includes a ${TRIAL_DAYS}-day free trial. Shopify only charges you after it ends, and you can cancel anytime before.`],
  ["How are charges calculated when I switch plans?", "Shopify bills app plans every 30 days and prorates the difference when you switch. The charge appears on your regular Shopify invoice."],
  ["Can I add more team members?", `Paid plans include 3 team members. Each extra seat is ${usd(SEAT_PRICE)}/month and is added to your plan's price.`],
  ["What happens if I uninstall the app?", "Your subscription is cancelled automatically by Shopify and you won't be charged again."],
];

export default function Billing() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useBusy();
  const current = PLANS.find((p) => p.key === d.current)!;
  const next = nextPlan(current);
  const [seats, setSeats] = useState(d.extraSeats);
  const [showFeatures, setShowFeatures] = useState(false);
  const pct = d.limit ? Math.min(100, (d.used / d.limit) * 100) : 0;
  const resets = new Date(d.resets).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const paid = current.price > 0;

  const subscribe = (planKey: string, extraSeats: number, label: string, primary = false) => (
    <Form method="post">
      <input type="hidden" name="intent" value="subscribe" />
      <input type="hidden" name="plan" value={planKey} />
      <input type="hidden" name="extraSeats" value={extraSeats} />
      <input type="hidden" name="subscriptionId" value={d.subscription?.id ?? ""} />
      <button className={`bw-btn sm${primary ? " dark" : ""}`} disabled={busy}>
        {label}
      </button>
    </Form>
  );

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      <div className="bw-head">
        <h1>Pricing plans</h1>
        {d.isTest && <span className="bw-badge amber">Test mode: no real charges</span>}
      </div>
      <Flash data={actionData} />

      <div className="bw-card bw-section" style={{ marginBottom: 14 }}>
        <div className="bw-row between">
          <div>
            <h2 style={{ fontSize: 20 }}>{current.name}</h2>
            <p className="bw-sub">
              {current.bookings === null ? "Unlimited bookings" : `Up to ${current.bookings} bookings per 30 days`} · Resets {resets}
              {d.subscription && d.subscription.trialDays > 0 ? ` · ${d.subscription.trialDays}-day trial` : ""}
            </p>
          </div>
          {d.subscription && (
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm("Cancel your plan and move to Free?")) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="cancel" />
              <input type="hidden" name="subscriptionId" value={d.subscription.id} />
              <button className="bw-btn plain" style={{ color: "var(--danger)" }}>
                Cancel plan
              </button>
            </Form>
          )}
        </div>
        <div style={{ height: 6, borderRadius: 4, background: "var(--surface-2)", margin: "14px 0 6px", overflow: "hidden" }}>
          <div style={{ width: `${d.limit === null ? 4 : pct}%`, height: "100%", background: d.limit !== null && d.used >= d.limit ? "var(--danger)" : "var(--accent-grad)" }} />
        </div>
        <div className="bw-row between">
          <b>
            {d.used} booking{d.used === 1 ? "" : "s"}
          </b>
          <span className="bw-help">{d.limit === null ? "No limit" : `Online booking pauses at ${d.hardLimit}`}</span>
        </div>
        {next && (
          <div className="bw-alert info bw-row between" style={{ marginTop: 14, marginBottom: 0 }}>
            <div>
              <b>Next plan: {next.name}</b>
              <div>{next.bookings === null ? "Unlimited bookings" : `Up to ${next.bookings} bookings per 30 days`}</div>
            </div>
            <div className="bw-row">
              <b>{usd(subscriptionPrice(next, d.extraSeats))}/mo</b>
              {subscribe(next.key, d.extraSeats, paid ? "Upgrade now" : d.trialAvailable ? `Start ${TRIAL_DAYS}-day free trial` : "Upgrade now", true)}
            </div>
          </div>
        )}
      </div>

      <div className="bw-card bw-section" style={{ marginBottom: 14 }}>
        <h2>Team members</h2>
        <p className="bw-sub">{current.seats} included with your plan</p>
        <div style={{ height: 6, borderRadius: 4, background: "var(--surface-2)", margin: "12px 0 6px", overflow: "hidden" }}>
          <div style={{ width: `${Math.min(100, (d.seatsUsed / d.seatsAllowed) * 100)}%`, height: "100%", background: "var(--accent-grad)" }} />
        </div>
        <div className="bw-row between">
          <b>
            {d.seatsUsed} / {d.seatsAllowed} used
          </b>
          <span className="bw-help">Each extra seat: {usd(SEAT_PRICE)}/mo</span>
        </div>
        <div className="bw-row between" style={{ marginTop: 12 }}>
          <div className="bw-row">
            <span>Extra seats</span>
            <button type="button" className="bw-btn sm" disabled={!paid || seats <= 0} onClick={() => setSeats(seats - 1)}>
              −
            </button>
            <b style={{ minWidth: 20, textAlign: "center" }}>{seats}</b>
            <button type="button" className="bw-btn sm" disabled={!paid || seats >= 50} onClick={() => setSeats(seats + 1)}>
              +
            </button>
          </div>
          <div className="bw-row">
            <b>{usd(seats * SEAT_PRICE)}/mo</b>
            {paid && seats !== d.extraSeats ? subscribe(current.key, seats, "Apply changes", true) : <button className="bw-btn sm" disabled>Apply changes</button>}
          </div>
        </div>
        {!paid && <p className="bw-help" style={{ marginTop: 8 }}>Extra seats are available on paid plans.</p>}
      </div>

      <div className="bw-card" style={{ marginBottom: 14 }}>
        <div className="bw-table-wrap">
          <table className="bw-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Monthly bookings</th>
                <th>Team members</th>
                <th>Price</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {PLANS.map((p) => (
                <tr key={p.key} style={p.recommended ? { background: "var(--amber-soft)" } : undefined}>
                  <td>
                    <b>{p.name}</b>{" "}
                    {p.recommended && <span className="bw-badge amber">Recommended</span>}
                    {p.popular && <span className="bw-badge blue">Most popular</span>}
                  </td>
                  <td>{p.bookings === null ? "Unlimited" : p.bookings.toLocaleString()}</td>
                  <td>{p.seats}</td>
                  <td>
                    <b>{p.price ? `${usd(p.price)}/mo` : "Free"}</b>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {p.key === current.key ? (
                      <button className="bw-btn sm" disabled>
                        Current plan
                      </button>
                    ) : (
                      subscribe(p.key, p.price ? d.extraSeats : 0, p.price === 0 ? "Downgrade" : "Select plan")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="bw-section">
          <button type="button" className="bw-btn plain" onClick={() => setShowFeatures(!showFeatures)}>
            {showFeatures ? "Hide features ▲" : "✓ All features included on every plan ▼"}
          </button>
          {showFeatures && (
            <div className="bw-grid two" style={{ marginTop: 10, gap: 6 }}>
              {FEATURES.map((f) => (
                <span key={f} className="bw-help" style={{ color: "var(--fg)" }}>
                  ✓ {f}
                </span>
              ))}
            </div>
          )}
          {d.trialAvailable && <p className="bw-help" style={{ marginTop: 10 }}>Your first paid plan starts with a {TRIAL_DAYS}-day free trial.</p>}
        </div>
      </div>

      <div className="bw-card bw-section">
        <h2 style={{ textAlign: "center", marginBottom: 10 }}>FAQ</h2>
        <div className="bw-stack" style={{ gap: 0 }}>
          {FAQ.map(([q, a]) => (
            <details key={q} style={{ borderTop: "1px solid var(--border)", padding: "12px 4px" }}>
              <summary style={{ fontWeight: 600, cursor: "pointer" }}>{q}</summary>
              <p className="bw-help" style={{ marginTop: 8, fontSize: 13 }}>
                {a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}
