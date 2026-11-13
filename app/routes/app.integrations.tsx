import crypto from "node:crypto";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop, invalidateShop } from "../models/shop.server";
import { decrypt, encrypt, signState } from "../models/crypto.server";
import { googleOAuthUrl, syncGoogleBusy } from "../models/calendar.server";
import { zoomConfigured, zoomOAuthUrl } from "../models/zoom.server";
import { aiAvailable } from "../models/ai.server";
import { bookPageUrl } from "../models/lifecycle.server";
import { Flash, Modal, useAppLink, useBusy } from "../components/ui";
import { microsoftConfigured, microsoftOAuthUrl, syncOutlookBusy } from "../models/microsoft.server";
import { hubspotPing } from "../models/hubspot.server";
import { transcript, voiceAvailable } from "../models/voice.server";

const appUrl = () => (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const [virtualAuto, meetServices, teamsServices, waiverCount, portalStaff, calls] = await Promise.all([
    prisma.service.count({ where: { shopId: shop.id, archived: false, autoZoom: true } }),
    prisma.service.count({ where: { shopId: shop.id, archived: false, autoMeet: true } }),
    prisma.service.count({ where: { shopId: shop.id, archived: false, autoTeams: true } }),
    prisma.waiver.count({ where: { shopId: shop.id, active: true } }),
    prisma.staffMember.count({ where: { shopId: shop.id, portalAccess: true, active: true } }),
    prisma.callSession.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const editor = `https://${shop.shopDomain}/admin/themes/current/editor`;
  return json({
    appUrl: appUrl(),
    s: {
      google: Boolean(shop.googleRefreshToken),
      googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      twoWaySyncOn: shop.twoWaySyncOn,
      googleBlockBusy: shop.googleBlockBusy,
      zoom: Boolean(shop.zoomRefreshToken),
      zoomConfigured: zoomConfigured(),
      zoomServices: virtualAuto,
      meetServices,
      createOrderWithoutCheckout: shop.createOrderWithoutCheckout,
      autoCancelBookingOnOrderCancel: shop.autoCancelBookingOnOrderCancel,
      klaviyo: Boolean(shop.klaviyoApiKey),
      webhookUrl: shop.webhookUrl ?? "",
      webhookSecret: decrypt(shop.webhookSecret) ?? "",
      apiKeyPrefix: shop.apiKeyPrefix ?? "",
      gaMeasurementId: shop.gaMeasurementId ?? "",
      metaPixelId: shop.metaPixelId ?? "",
      email: Boolean(shop.resendApiKey && shop.notifyFromEmail),
      sms: shop.smsEnabled && Boolean(shop.twilioAccountSid),
      whatsapp: shop.whatsappEnabled && Boolean(shop.twilioWhatsappFrom),
      ai: aiAvailable(),
      ms: Boolean(shop.msRefreshToken),
      msAccount: shop.msAccount ?? "",
      msConfigured: microsoftConfigured(),
      outlookSyncOn: shop.outlookSyncOn,
      outlookBlockBusy: shop.outlookBlockBusy,
      teamsServices,
      icsUrl: shop.icsToken ? `${appUrl()}/feeds/${shop.icsToken}.ics` : "",
      hubspot: Boolean(shop.hubspotToken),
      waiverCount,
      portalStaff,
      twilio: Boolean(shop.twilioAccountSid && shop.twilioAuthToken),
      voiceEnabled: shop.voiceEnabled,
      voiceUrl: shop.voiceToken ? `${appUrl()}/voice/${shop.voiceToken}` : "",
      voiceGreeting: shop.voiceGreeting ?? "",
      voiceInstructions: shop.voiceInstructions ?? "",
      voiceReady: voiceAvailable(),
    },
    calls: calls.map((c) => ({
      id: c.id,
      caller: c.caller ?? "Unknown",
      at: c.createdAt.toISOString(),
      booked: Boolean(c.bookingId),
      lines: transcript(c.messages),
    })),
    links: {
      bookPage: bookPageUrl(shop.shopDomain),
      addBlock: `${editor}?template=product&addAppBlockId=${apiKey}/booking&target=mainSection`,
      embed: `${editor}?context=apps&activateAppId=${apiKey}/embed`,
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  invalidateShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const f = (k: string) => String(form.get(k) || "").trim();
  const on = (k: string) => form.get(k) === "on";
  const update = (data: Parameters<typeof prisma.shop.update>[0]["data"]) => prisma.shop.update({ where: { id: shop.id }, data });

  switch (intent) {
    case "connectGoogle":
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return json({ error: "Google isn't set up on this app yet: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are empty (see the README)." }, { status: 400 });
      }
      // Google's consent screen can't open inside the admin iframe.
      return redirect(googleOAuthUrl(`${appUrl()}/oauth/google/callback`, signState(shop.shopDomain)), { target: "_top" });
    case "disconnectGoogle":
      await update({ googleRefreshToken: null, googleAccessToken: null, googleTokenExpiry: null, twoWaySyncOn: false, googleBlockBusy: false });
      await prisma.externalBusy.deleteMany({ where: { shopId: shop.id } });
      return json({ ok: "Google Calendar disconnected.", done: true });
    case "google": {
      await update({ twoWaySyncOn: on("twoWaySyncOn"), googleBlockBusy: on("googleBlockBusy") });
      if (on("googleBlockBusy")) {
        const fresh = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
        await syncGoogleBusy(fresh).catch(() => 0);
      } else {
        await prisma.externalBusy.deleteMany({ where: { shopId: shop.id } });
      }
      return json({ ok: "Google Calendar settings saved.", done: true });
    }
    case "connectZoom":
      if (!zoomConfigured()) {
        return json({ error: "Zoom isn't set up on this app yet: ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are empty (see the README)." }, { status: 400 });
      }
      return redirect(zoomOAuthUrl(`${appUrl()}/oauth/zoom/callback`, signState(shop.shopDomain)), { target: "_top" });
    case "disconnectZoom":
      await update({ zoomRefreshToken: null, zoomAccessToken: null, zoomTokenExpiry: null });
      return json({ ok: "Zoom disconnected.", done: true });
    case "shopify":
      await update({
        createOrderWithoutCheckout: on("createOrderWithoutCheckout"),
        autoCancelBookingOnOrderCancel: on("autoCancelBookingOnOrderCancel"),
      });
      return json({ ok: "Shopify settings saved.", done: true });
    case "klaviyo": {
      const key = f("klaviyoApiKey");
      if (!key) return json({ error: "Paste your Klaviyo private API key." }, { status: 400 });
      await update({ klaviyoApiKey: encrypt(key) });
      return json({ ok: "Klaviyo connected.", done: true });
    }
    case "clearKlaviyo":
      await update({ klaviyoApiKey: null });
      return json({ ok: "Klaviyo disconnected.", done: true });
    case "webhook": {
      const url = f("webhookUrl");
      if (url && !/^https:\/\/[^\s]+$/i.test(url)) return json({ error: "The webhook URL must start with https://" }, { status: 400 });
      await update({
        webhookUrl: url || null,
        ...(url && !shop.webhookSecret ? { webhookSecret: encrypt(crypto.randomBytes(24).toString("hex")) } : {}),
      });
      return json({ ok: url ? "Webhook saved." : "Webhook removed." });
    }
    case "rotateWebhookSecret":
      await update({ webhookSecret: encrypt(crypto.randomBytes(24).toString("hex")) });
      return json({ ok: "New signing secret created." });
    case "apiKey": {
      const key = `bw_${crypto.randomBytes(24).toString("hex")}`;
      await update({ apiKeyHash: crypto.createHash("sha256").update(key).digest("hex"), apiKeyPrefix: key.slice(0, 10) });
      return json({ ok: "New API key created. Copy it now: it won't be shown again.", apiKey: key });
    }
    case "revokeApiKey":
      await update({ apiKeyHash: null, apiKeyPrefix: null });
      return json({ ok: "API key revoked." });
    case "ga": {
      const id = f("gaMeasurementId");
      if (id && !/^G-[A-Z0-9]{4,20}$/i.test(id)) return json({ error: "Google Analytics IDs look like G-XXXXXXX." }, { status: 400 });
      await update({ gaMeasurementId: id || null });
      return json({ ok: id ? "Google Analytics connected." : "Google Analytics removed.", done: true });
    }
    case "connectMicrosoft":
      if (!microsoftConfigured()) {
        return json({ error: "Microsoft isn't set up on this app yet: MS_CLIENT_ID and MS_CLIENT_SECRET are empty (see the README)." }, { status: 400 });
      }
      return redirect(microsoftOAuthUrl(`${appUrl()}/oauth/microsoft/callback`, signState(shop.shopDomain)), { target: "_top" });
    case "disconnectMicrosoft":
      await update({ msRefreshToken: null, msAccessToken: null, msTokenExpiry: null, msAccount: null, outlookSyncOn: false, outlookBlockBusy: false });
      await prisma.externalBusy.deleteMany({ where: { shopId: shop.id, source: "outlook" } });
      return json({ ok: "Microsoft account disconnected.", done: true });
    case "outlook": {
      await update({ outlookSyncOn: on("outlookSyncOn"), outlookBlockBusy: on("outlookBlockBusy") });
      if (on("outlookBlockBusy")) {
        const fresh = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
        await syncOutlookBusy(fresh).catch(() => 0);
      } else {
        await prisma.externalBusy.deleteMany({ where: { shopId: shop.id, source: "outlook" } });
      }
      return json({ ok: "Outlook settings saved.", done: true });
    }
    case "icsOn":
      await update({ icsToken: crypto.randomBytes(24).toString("hex") });
      return json({ ok: "Calendar feed created. Add the link to Apple Calendar." });
    case "icsOff":
      await update({ icsToken: null });
      return json({ ok: "Calendar feed turned off. The old link no longer works." });
    case "hubspot": {
      const token = f("hubspotToken");
      if (!token) return json({ error: "Paste your HubSpot private app access token." }, { status: 400 });
      try {
        await hubspotPing(token);
      } catch (e) {
        return json({ error: `HubSpot: ${(e as Error).message}` }, { status: 400 });
      }
      await update({ hubspotToken: encrypt(token) });
      return json({ ok: "HubSpot connected. New bookings will appear on your contacts.", done: true });
    }
    case "clearHubspot":
      await update({ hubspotToken: null });
      return json({ ok: "HubSpot disconnected.", done: true });
    case "zapierTest": {
      if (!shop.webhookUrl) return json({ error: "Add your Zapier webhook URL first." }, { status: 400 });
      const body = JSON.stringify({
        event: "booking.created",
        shop: shop.shopDomain,
        sentAt: new Date().toISOString(),
        test: true,
        data: {
          id: "test_booking",
          status: "confirmed",
          service: { id: "test_service", name: "Sample service", type: "appointment" },
          staff: { id: "test_staff", name: "Sample team member" },
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 86_400_000 + 3_600_000).toISOString(),
          timezone: shop.timezone,
          quantity: 1,
          customer: { name: "Test Customer", email: "test@example.com", phone: "+15555550123" },
          answers: [],
          addons: [],
          totalPrice: 50,
          amountDue: 0,
          paymentStatus: "none",
          source: "widget",
        },
      });
      const secret = decrypt(shop.webhookSecret) || "";
      try {
        const res = await fetch(shop.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bookwell-Event": "booking.created", "X-Bookwell-Signature": crypto.createHmac("sha256", secret).update(body).digest("base64") },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        return json(res.ok ? { ok: "Test event sent. Check your Zap." } : { error: `Your endpoint answered HTTP ${res.status}.` });
      } catch (e) {
        return json({ error: `Couldn't reach your endpoint: ${(e as Error).message}` });
      }
    }
    case "voice": {
      const enable = on("voiceEnabled");
      await update({
        voiceEnabled: enable,
        voiceGreeting: f("voiceGreeting").slice(0, 300) || null,
        voiceInstructions: f("voiceInstructions").slice(0, 2000) || null,
        ...(enable && !shop.voiceToken ? { voiceToken: crypto.randomBytes(20).toString("hex") } : {}),
      });
      return json({ ok: enable ? "Phone receptionist saved." : "Phone receptionist turned off." });
    }
    case "rotateVoice":
      await update({ voiceToken: crypto.randomBytes(20).toString("hex") });
      return json({ ok: "New webhook URL created. Update it in Twilio." });
    case "meta": {
      const id = f("metaPixelId");
      if (id && !/^\d{5,20}$/.test(id)) return json({ error: "A Meta Pixel ID is a number." }, { status: 400 });
      await update({ metaPixelId: id || null });
      return json({ ok: id ? "Meta Pixel connected." : "Meta Pixel removed.", done: true });
    }
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

type S = ReturnType<typeof useLoaderData<typeof loader>>["s"];
type CardDef = {
  id: string;
  title: string;
  blurb: string;
  logo: { bg: string; fg?: string; text: string };
  status: (s: S) => { label: string; tone: "green" | "" | "amber" };
  group: string;
};

const CARDS: CardDef[] = [
  { id: "google", group: "Calendars & meetings", title: "Google Calendar", blurb: "Two-way sync: send bookings to your calendar and block times you're busy.", logo: { bg: "#e8f0fe", fg: "#1a73e8", text: "31" }, status: (s) => (s.google ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "meet", group: "Calendars & meetings", title: "Google Meet", blurb: "Create a unique Google Meet link for every virtual booking.", logo: { bg: "#e6f4ea", fg: "#188038", text: "▶" }, status: (s) => (s.google && s.meetServices ? { label: `On for ${s.meetServices} service(s)`, tone: "green" } : s.google ? { label: "Ready", tone: "amber" } : { label: "Needs Google", tone: "" }) },
  { id: "outlook", group: "Calendars & meetings", title: "Outlook Calendar", blurb: "Two-way sync with Outlook / Microsoft 365: send bookings and block busy times.", logo: { bg: "#e6f0fb", fg: "#0f6cbd", text: "O" }, status: (s) => (s.ms ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "apple", group: "Calendars & meetings", title: "Apple Calendar", blurb: "Subscribe to your bookings in Apple Calendar (or any calendar app) with a private feed.", logo: { bg: "#f2f2f2", fg: "#111", text: "" }, status: (s) => (s.icsUrl ? { label: "Feed on", tone: "green" } : { label: "Off", tone: "" }) },
  { id: "teams", group: "Calendars & meetings", title: "Microsoft Teams", blurb: "Create a Microsoft Teams meeting link for every virtual booking.", logo: { bg: "#ecebfa", fg: "#5b5fc7", text: "T" }, status: (s) => (s.ms && s.teamsServices ? { label: `On for ${s.teamsServices} service(s)`, tone: "green" } : s.ms ? { label: "Ready", tone: "amber" } : { label: "Needs Microsoft", tone: "" }) },
  { id: "zoom", group: "Calendars & meetings", title: "Zoom", blurb: "Automatic Zoom meeting links for your virtual bookings.", logo: { bg: "#e8f1ff", fg: "#2d8cff", text: "zoom" }, status: (s) => (s.zoom ? { label: s.zoomServices ? `On for ${s.zoomServices} service(s)` : "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "shopify", group: "Shopify", title: "Orders & payments", blurb: "Create orders for pay-later bookings and cancel bookings together with their orders.", logo: { bg: "#e3f1df", fg: "#008060", text: "S" }, status: (s) => (s.createOrderWithoutCheckout || s.autoCancelBookingOnOrderCancel ? { label: "On", tone: "green" } : { label: "Off", tone: "" }) },
  { id: "pos", group: "Shopify", title: "Shopify POS", blurb: "See today's bookings and check guests in from the POS tile.", logo: { bg: "#e3f1df", fg: "#008060", text: "POS" }, status: () => ({ label: "Available", tone: "green" }) },
  { id: "storefront", group: "Shopify", title: "Store widget & booking page", blurb: "Calendar on product pages, a floating “Book now” button, and a booking page.", logo: { bg: "#eceafd", fg: "#5b5bd6", text: "📅" }, status: () => ({ label: "Available", tone: "green" }) },
  { id: "waivers", group: "Shopify", title: "Waivers", blurb: "Customers sign a waiver before booking; signatures are stored with each booking.", logo: { bg: "#fff4e5", fg: "#b45309", text: "✍" }, status: (s) => (s.waiverCount ? { label: `${s.waiverCount} active`, tone: "green" } : { label: "None yet", tone: "" }) },
  { id: "mobile", group: "Shopify", title: "Mobile app", blurb: "Your team installs Bookwell on their phones to see bookings and update hours.", logo: { bg: "#eceafd", fg: "#5b5bd6", text: "📱" }, status: (s) => (s.portalStaff ? { label: `${s.portalStaff} team member(s)`, tone: "green" } : { label: "Not set up", tone: "" }) },
  { id: "phone", group: "Shopify", title: "AI phone receptionist", blurb: "Answers your phone 24/7, checks availability and books callers.", logo: { bg: "#fbefe8", fg: "#d97757", text: "☎" }, status: (s) => (s.voiceEnabled && s.voiceUrl ? { label: "On", tone: "green" } : { label: "Off", tone: "" }) },
  { id: "email", group: "Notifications", title: "Email (Resend)", blurb: "Confirmation, reminder and cancellation emails from your own domain.", logo: { bg: "#111", fg: "#fff", text: "R" }, status: (s) => (s.email ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "sms", group: "Notifications", title: "SMS (Twilio)", blurb: "Text message confirmations and reminders.", logo: { bg: "#fde8ea", fg: "#f22f46", text: "SMS" }, status: (s) => (s.sms ? { label: "On", tone: "green" } : { label: "Off", tone: "" }) },
  { id: "whatsapp", group: "Notifications", title: "WhatsApp (Twilio)", blurb: "WhatsApp confirmations and reminders.", logo: { bg: "#e7f8ee", fg: "#25d366", text: "WA" }, status: (s) => (s.whatsapp ? { label: "On", tone: "green" } : { label: "Off", tone: "" }) },
  { id: "hubspot", group: "Marketing", title: "HubSpot", blurb: "Add customers as contacts and log every booking on their timeline.", logo: { bg: "#fff1ec", fg: "#ff7a59", text: "H" }, status: (s) => (s.hubspot ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "klaviyo", group: "Marketing", title: "Klaviyo", blurb: "Send booking events to Klaviyo to trigger flows and segments.", logo: { bg: "#f4f4f4", fg: "#111", text: "K" }, status: (s) => (s.klaviyo ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "ga", group: "Marketing", title: "Google Analytics 4", blurb: "Track completed bookings as a conversion event.", logo: { bg: "#fef3e0", fg: "#e37400", text: "GA" }, status: (s) => (s.gaMeasurementId ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "meta", group: "Marketing", title: "Meta Pixel", blurb: "Track bookings as a “Schedule” event for Facebook & Instagram ads.", logo: { bg: "#e7f0ff", fg: "#0866ff", text: "∞" }, status: (s) => (s.metaPixelId ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "zapier", group: "Developers", title: "Zapier", blurb: "Connect bookings to 6,000+ apps (Sheets, Slack, Mailchimp…) with Zaps.", logo: { bg: "#fff1ea", fg: "#ff4f00", text: "✱" }, status: (s) => (s.webhookUrl.includes("zapier.com") ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "webhooks", group: "Developers", title: "Webhooks", blurb: "Real-time booking events (created, cancelled, rescheduled) to any URL.", logo: { bg: "#f2f1fb", fg: "#201f3d", text: "{ }" }, status: (s) => (s.webhookUrl ? { label: "Connected", tone: "green" } : { label: "Not connected", tone: "" }) },
  { id: "api", group: "Developers", title: "Public API", blurb: "REST API for services, availability and bookings to build your own integration.", logo: { bg: "#f2f1fb", fg: "#201f3d", text: "API" }, status: (s) => (s.apiKeyPrefix ? { label: "Key active", tone: "green" } : { label: "No key", tone: "" }) },
  { id: "ai", group: "Developers", title: "AI service builder", blurb: "Describe a service in your own words and Claude sets it up for you.", logo: { bg: "#fbefe8", fg: "#d97757", text: "✳" }, status: (s) => (s.ai ? { label: "Ready", tone: "green" } : { label: "Needs API key", tone: "" }) },
];

export default function Integrations() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (actionData && "done" in actionData) setOpen(null);
  }, [actionData]);
  const groups = [...new Set(CARDS.map((c) => c.group))];
  const card = CARDS.find((c) => c.id === open);

  return (
    <div>
      <div className="bw-head">
        <div>
          <h1>Integrations</h1>
          <p className="bw-sub">Every integration is included on every plan.</p>
        </div>
      </div>
      <Flash data={actionData} />
      {actionData && "apiKey" in actionData && <div className="bw-alert info bw-code">{String(actionData.apiKey)}</div>}

      {groups.map((g) => (
        <section key={g} style={{ marginBottom: 20 }}>
          <div className="bw-label" style={{ marginBottom: 10, color: "var(--muted)", textTransform: "uppercase", fontSize: 11.5, letterSpacing: ".05em" }}>
            {g}
          </div>
          <div className="int-grid">
            {CARDS.filter((c) => c.group === g).map((c) => {
              const st = c.status(d.s);
              return (
                <button key={c.id} type="button" className="int-card" onClick={() => setOpen(c.id)}>
                  <div className="int-top">
                    <span className="int-logo" style={{ background: c.logo.bg, color: c.logo.fg }}>
                      {c.logo.text}
                    </span>
                    <span className={`bw-badge ${st.tone}`}>{st.label}</span>
                  </div>
                  <div className="int-title">{c.title}</div>
                  <div className="int-blurb">{c.blurb}</div>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {card && (
        <Modal title={card.title} onClose={() => setOpen(null)} wide>
          <p className="bw-sub" style={{ margin: 0 }}>
            {card.blurb}
          </p>
          <Detail id={card.id} d={d} />
        </Modal>
      )}
    </div>
  );
}

function Toggle({ name, title, sub, checked, disabled }: { name: string; title: string; sub?: string; checked?: boolean; disabled?: boolean }) {
  return (
    <label className="bw-check-row" style={{ opacity: disabled ? 0.55 : 1 }}>
      <input type="checkbox" name={name} defaultChecked={checked} disabled={disabled} />
      <div>
        <div className="t">{title}</div>
        {sub && <div className="s">{sub}</div>}
      </div>
    </label>
  );
}

function Btn({ intent, label, tone }: { intent: string; label: string; tone?: "primary" | "danger" | "dark" }) {
  const busy = useBusy();
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <button className={`bw-btn${tone ? ` ${tone}` : ""}`} disabled={busy}>
        {label}
      </button>
    </Form>
  );
}

function Detail({ id, d }: { id: string; d: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const link = useAppLink();
  const busy = useBusy();
  const s = d.s;
  const missing = (vars: string) => (
    <div className="bw-alert warn" style={{ margin: 0 }}>
      Not set up on this app yet: add {vars} to the app's environment (see the README).
    </div>
  );

  switch (id) {
    case "google":
      return (
        <div className="bw-stack">
          {!s.googleConfigured && !s.google && missing("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET")}
          <div className="bw-row">{s.google ? <><Btn intent="connectGoogle" label="Reconnect" /><Btn intent="disconnectGoogle" label="Disconnect" tone="danger" /></> : <Btn intent="connectGoogle" label="Connect Google Calendar" tone="primary" />}</div>
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="google" />
            <Toggle name="twoWaySyncOn" title="Send bookings to Google Calendar" sub="New, moved and cancelled bookings update your calendar." checked={s.twoWaySyncOn} disabled={!s.google} />
            <Toggle name="googleBlockBusy" title="Block times that are busy in Google Calendar" sub="Your own events stop customers booking those times. Refreshed every 5 minutes." checked={s.googleBlockBusy} disabled={!s.google} />
            <div>
              <button className="bw-btn primary" disabled={busy || !s.google}>Save</button>
            </div>
          </Form>
        </div>
      );
    case "outlook":
      return (
        <div className="bw-stack">
          {!s.msConfigured && !s.ms && missing("MS_CLIENT_ID and MS_CLIENT_SECRET")}
          {s.ms && <span className="bw-badge green" style={{ alignSelf: "flex-start" }}>Connected as {s.msAccount || "Microsoft account"}</span>}
          <div className="bw-row">{s.ms ? <><Btn intent="connectMicrosoft" label="Reconnect" /><Btn intent="disconnectMicrosoft" label="Disconnect" tone="danger" /></> : <Btn intent="connectMicrosoft" label="Connect Outlook" tone="primary" />}</div>
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="outlook" />
            <Toggle name="outlookSyncOn" title="Send bookings to Outlook Calendar" checked={s.outlookSyncOn} disabled={!s.ms} />
            <Toggle name="outlookBlockBusy" title="Block times that are busy in Outlook" sub="Your own Outlook events stop customers booking those times. Refreshed every 5 minutes." checked={s.outlookBlockBusy} disabled={!s.ms} />
            <div><button className="bw-btn primary" disabled={busy || !s.ms}>Save</button></div>
          </Form>
        </div>
      );
    case "teams":
      return (
        <div className="bw-stack">
          {!s.ms && <div className="bw-alert warn" style={{ margin: 0 }}>Connect Outlook Calendar first (same Microsoft account). Teams links need a work or school Microsoft 365 account.</div>}
          <p style={{ margin: 0 }}>Open a <b>Virtual</b> service and choose “A new Microsoft Teams meeting for every booking”. The join link goes in the confirmation and reminder emails.</p>
          <Link className="bw-btn primary" to={link("/app/services")} style={{ alignSelf: "flex-start" }}>Go to services</Link>
        </div>
      );
    case "apple":
      return (
        <div className="bw-stack">
          <p style={{ margin: 0, fontSize: 13.5 }}>
            Apple doesn't let apps write to iCloud calendars, so Bookwell publishes a private calendar feed instead. Apple Calendar checks it automatically and shows every booking (it also works with Google Calendar and Outlook). Customers get an “Add to calendar” link in their emails.
          </p>
          {s.icsUrl ? (
            <>
              <div className="bw-field">
                <label>Your private feed link (keep it secret)</label>
                <div className="bw-row">
                  <span className="bw-code" style={{ flex: 1 }}>{s.icsUrl}</span>
                  <button type="button" className="bw-btn sm" onClick={() => navigator.clipboard?.writeText(s.icsUrl)}>Copy</button>
                </div>
              </div>
              <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
                <li><b>Mac:</b> Calendar → File → New Calendar Subscription → paste the link.</li>
                <li><b>iPhone:</b> Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar → paste the link.</li>
                <li>One team member only: add <span className="bw-code" style={{ padding: "1px 6px" }}>?staff=TEAM_MEMBER_ID</span> to the link.</li>
              </ol>
              <div className="bw-row"><Btn intent="icsOn" label="Create a new link" /><Btn intent="icsOff" label="Turn off" tone="danger" /></div>
            </>
          ) : (
            <Btn intent="icsOn" label="Create calendar feed" tone="primary" />
          )}
        </div>
      );
    case "waivers":
      return (
        <div className="bw-stack">
          <p style={{ margin: 0 }}>Write a waiver, pick the services that need it, and customers sign it on screen before they can book. View or print every signature.</p>
          <Link className="bw-btn primary" to={link("/app/waivers")} style={{ alignSelf: "flex-start" }}>Manage waivers</Link>
        </div>
      );
    case "mobile":
      return (
        <div className="bw-stack">
          <p style={{ margin: 0, fontSize: 13.5 }}>
            Each team member gets a private link to their own portal, which installs on their phone like an app: today's and upcoming bookings, their working hours, and (if you allow it) adding bookings.
          </p>
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
            <li>Go to <b>Team</b>, edit a team member and tick “Can open the team portal”.</li>
            <li>Send them the portal link.</li>
            <li><b>Android:</b> open it in Chrome and tap “Install app”. <b>iPhone:</b> open it in Safari → Share → “Add to Home Screen”.</li>
          </ol>
          <p className="bw-help" style={{ margin: 0 }}>To manage everything from your phone, use the Shopify mobile app: Bookwell opens inside it.</p>
          <Link className="bw-btn primary" to={link("/app/staff")} style={{ alignSelf: "flex-start" }}>Go to Team</Link>
        </div>
      );
    case "phone":
      return <PhoneAgent d={d} />;
    case "hubspot":
      return (
        <div className="bw-stack">
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
            <li>In HubSpot: Settings → Integrations → Private Apps → Create a private app.</li>
            <li>Scopes: <b>crm.objects.contacts.read</b> and <b>crm.objects.contacts.write</b>. Create it and copy the access token.</li>
          </ol>
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="hubspot" />
            <div className="bw-field">
              <label>Access token</label>
              <input name="hubspotToken" type="password" autoComplete="off" className="bw-input" placeholder={s.hubspot ? "Saved (paste a new token to replace)" : "pat-..."} />
            </div>
            <div><button className="bw-btn primary" disabled={busy}>{s.hubspot ? "Replace token" : "Connect HubSpot"}</button></div>
          </Form>
          {s.hubspot && <Btn intent="clearHubspot" label="Disconnect HubSpot" tone="danger" />}
          <p className="bw-help" style={{ margin: 0 }}>Each booking creates or updates the contact and logs a meeting; cancellations add a note.</p>
        </div>
      );
    case "zapier":
      return (
        <div className="bw-stack">
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
            <li>In Zapier, create a Zap with the trigger <b>Webhooks by Zapier → Catch Hook</b> and copy its URL.</li>
            <li>Paste it below and save, then click “Send test event” so Zapier sees a sample booking.</li>
            <li>Add any action: Google Sheets row, Slack message, Mailchimp subscriber… Use the <b>event</b> field to tell created, cancelled and rescheduled apart.</li>
          </ol>
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="webhook" />
            <div className="bw-field">
              <label>Zapier webhook URL</label>
              <input name="webhookUrl" className="bw-input" defaultValue={s.webhookUrl} placeholder="https://hooks.zapier.com/hooks/catch/..." />
              <span className="bw-help">This uses the same slot as Webhooks (one endpoint per store).</span>
            </div>
            <div className="bw-row">
              <button className="bw-btn primary" disabled={busy}>Save</button>
            </div>
          </Form>
          <Btn intent="zapierTest" label="Send test event" />
          <p className="bw-help" style={{ margin: 0 }}>To create bookings from Zapier, use “Webhooks by Zapier → POST” with the Public API.</p>
        </div>
      );
    case "meet":
      return (
        <div className="bw-stack">
          {!s.google && <div className="bw-alert warn" style={{ margin: 0 }}>Connect Google Calendar first.</div>}
          <p style={{ margin: 0 }}>
            Turn it on per service: open a <b>Virtual</b> service and choose “A new Google Meet for every booking”. The link goes in the confirmation and reminder emails.
          </p>
          <Link className="bw-btn primary" to={link("/app/services")} style={{ alignSelf: "flex-start" }}>Go to services</Link>
        </div>
      );
    case "zoom":
      return (
        <div className="bw-stack">
          {!s.zoomConfigured && !s.zoom && missing("ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET")}
          <div className="bw-row">{s.zoom ? <><Btn intent="connectZoom" label="Reconnect" /><Btn intent="disconnectZoom" label="Disconnect" tone="danger" /></> : <Btn intent="connectZoom" label="Connect Zoom" tone="primary" />}</div>
          <p className="bw-help" style={{ margin: 0 }}>
            Then open a <b>Virtual</b> service and choose “A new Zoom meeting for every booking”. Reschedules and cancellations update the meeting.
          </p>
        </div>
      );
    case "shopify":
      return (
        <Form method="post" className="bw-stack">
          <input type="hidden" name="intent" value="shopify" />
          <Toggle name="createOrderWithoutCheckout" title="Create a Shopify order for pay-later bookings" sub="Free / pay-at-appointment bookings get a payment-pending order." checked={s.createOrderWithoutCheckout} />
          <Toggle name="autoCancelBookingOnOrderCancel" title="Cancel the booking when its order is cancelled" sub="Checked every 30 minutes." checked={s.autoCancelBookingOnOrderCancel} />
          <span className="bw-help">
            Refund rules live in <Link to={link("/app/settings", { tab: "orders" })}>Settings → Orders & refunds</Link>.
          </span>
          <div>
            <button className="bw-btn primary" disabled={busy}>Save</button>
          </div>
        </Form>
      );
    case "pos":
      return (
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13.5 }}>
          <li>Open the Shopify POS app on your device.</li>
          <li>On the home screen, tap <b>Add tile</b> and choose <b>Bookwell</b>.</li>
          <li>Tap the tile to see the rest of today's bookings and check guests in.</li>
        </ol>
      );
    case "storefront":
      return (
        <div className="bw-stack">
          <div className="bw-option">
            <div><b>Calendar on product pages</b><div className="bw-help">Adds the booking block to your product template.</div></div>
            <a className="bw-btn primary" href={d.links.addBlock} target="_blank" rel="noreferrer">Add to theme</a>
          </div>
          <div className="bw-option">
            <div><b>Floating “Book now” button</b><div className="bw-help">On every page of your store.</div></div>
            <a className="bw-btn" href={d.links.embed} target="_blank" rel="noreferrer">Turn on</a>
          </div>
          <div className="bw-option">
            <div><b>Booking page</b><div className="bw-code" style={{ marginTop: 6 }}>{d.links.bookPage}</div></div>
            <a className="bw-btn" href={d.links.bookPage} target="_blank" rel="noreferrer">Open</a>
          </div>
        </div>
      );
    case "email":
    case "sms":
    case "whatsapp":
      return (
        <div className="bw-stack">
          <p style={{ margin: 0 }}>
            {id === "email"
              ? "Uses your own Resend account so emails come from your domain. Add your API key and “From” address."
              : "Uses your own Twilio account. Add your Account SID, Auth Token and sender number, then switch it on."}
          </p>
          <Link className="bw-btn primary" to={link("/app/settings", { tab: "notifications" })} style={{ alignSelf: "flex-start" }}>Set up in Email & SMS settings</Link>
        </div>
      );
    case "klaviyo":
      return (
        <div className="bw-stack">
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="klaviyo" />
            <div className="bw-field">
              <label>Private API key</label>
              <input name="klaviyoApiKey" type="password" autoComplete="off" className="bw-input" placeholder={s.klaviyo ? "Saved (enter a new key to replace)" : "pk_..."} />
              <span className="bw-help">Events: “Bookwell booking.created”, “booking.cancelled”, “booking.rescheduled”.</span>
            </div>
            <div>
              <button className="bw-btn primary" disabled={busy}>{s.klaviyo ? "Replace key" : "Connect"}</button>
            </div>
          </Form>
          {s.klaviyo && <Btn intent="clearKlaviyo" label="Disconnect Klaviyo" tone="danger" />}
        </div>
      );
    case "ga":
    case "meta":
      return (
        <Form method="post" className="bw-stack">
          <input type="hidden" name="intent" value={id} />
          <div className="bw-field">
            <label>{id === "ga" ? "Measurement ID" : "Pixel ID"}</label>
            <input name={id === "ga" ? "gaMeasurementId" : "metaPixelId"} className="bw-input" defaultValue={id === "ga" ? s.gaMeasurementId : s.metaPixelId} placeholder={id === "ga" ? "G-XXXXXXX" : "123456789012345"} />
            <span className="bw-help">Leave empty and save to remove it.</span>
          </div>
          <div>
            <button className="bw-btn primary" disabled={busy}>Save</button>
          </div>
        </Form>
      );
    case "webhooks":
      return (
        <div className="bw-stack">
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="webhook" />
            <div className="bw-field">
              <label>Endpoint URL</label>
              <input name="webhookUrl" className="bw-input" defaultValue={s.webhookUrl} placeholder="https://example.com/hooks/bookwell" />
              <span className="bw-help">We POST JSON signed with HMAC-SHA256 (header X-Bookwell-Signature, base64) for booking.created, booking.cancelled and booking.rescheduled.</span>
            </div>
            <div>
              <button className="bw-btn primary" disabled={busy}>Save</button>
            </div>
          </Form>
          {s.webhookSecret && (
            <div className="bw-field">
              <label>Signing secret</label>
              <span className="bw-code">{s.webhookSecret}</span>
              <div style={{ marginTop: 6 }}>
                <Btn intent="rotateWebhookSecret" label="Create a new secret" />
              </div>
            </div>
          )}
        </div>
      );
    case "api":
      return (
        <div className="bw-stack">
          <p style={{ margin: 0, fontSize: 13.5 }}>
            Endpoints at <span className="bw-code">{d.appUrl}/api/v1/</span>: <b>services</b>, <b>availability</b>, <b>bookings</b> (list, create, cancel). Send the key as{" "}
            <span className="bw-code">Authorization: Bearer &lt;key&gt;</span>.
          </p>
          <div className="bw-row">
            {s.apiKeyPrefix ? <span className="bw-badge green">Active key: {s.apiKeyPrefix}…</span> : <span className="bw-badge">No key</span>}
            <Btn intent="apiKey" label={s.apiKeyPrefix ? "Replace key" : "Create API key"} tone="primary" />
            {s.apiKeyPrefix && <Btn intent="revokeApiKey" label="Revoke" tone="danger" />}
          </div>
        </div>
      );
    case "ai":
      return (
        <div className="bw-stack">
          {!s.ai && missing("ANTHROPIC_API_KEY")}
          <p style={{ margin: 0 }}>Go to Services → New service and describe what you sell. Claude drafts the service (type, price, hours, add-ons, questions) for you to review.</p>
          <Link className="bw-btn primary" to={link("/app/services", { new: 1 })} style={{ alignSelf: "flex-start" }}>Try it</Link>
        </div>
      );
  }
  return null;
}

function PhoneAgent({ d }: { d: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const busy = useBusy();
  const link = useAppLink();
  const s = d.s;
  const [show, setShow] = useState<string | null>(null);
  return (
    <div className="bw-stack">
      {!s.voiceReady && <div className="bw-alert warn" style={{ margin: 0 }}>Needs ANTHROPIC_API_KEY in the app's environment (see the README).</div>}
      {!s.twilio && (
        <div className="bw-alert warn" style={{ margin: 0 }}>
          Needs your Twilio account: add the Account SID and Auth Token in <Link to={link("/app/settings", { tab: "notifications" })}>Email & SMS settings</Link>, and buy a phone number in Twilio.
        </div>
      )}
      <Form method="post" className="bw-stack">
        <input type="hidden" name="intent" value="voice" />
        <label className="bw-check-row">
          <input type="checkbox" name="voiceEnabled" defaultChecked={s.voiceEnabled} />
          <div><div className="t">Answer calls with the AI receptionist</div><div className="s">It books into the same calendar as your website, so it never double-books.</div></div>
        </label>
        <div className="bw-field">
          <label>Greeting</label>
          <input name="voiceGreeting" className="bw-input" defaultValue={s.voiceGreeting} placeholder="Hi, thanks for calling! I can help you book an appointment. What would you like to book?" />
        </div>
        <div className="bw-field">
          <label>Extra instructions (optional)</label>
          <textarea name="voiceInstructions" className="bw-textarea" defaultValue={s.voiceInstructions} placeholder="e.g. We're closed on public holidays. Parking is behind the building. New clients should book a consultation first." />
        </div>
        <div><button className="bw-btn primary" disabled={busy}>Save</button></div>
      </Form>
      {s.voiceUrl && (
        <div className="bw-field">
          <label>Twilio setup</label>
          <span className="bw-help">In Twilio → Phone Numbers → your number → Voice: “A call comes in” → Webhook → HTTP POST →</span>
          <div className="bw-row">
            <span className="bw-code" style={{ flex: 1 }}>{s.voiceUrl}</span>
            <button type="button" className="bw-btn sm" onClick={() => navigator.clipboard?.writeText(s.voiceUrl)}>Copy</button>
          </div>
          <span className="bw-help">In development this URL changes every time the dev server restarts; deployed, it stays fixed.</span>
        </div>
      )}
      {d.calls.length > 0 && (
        <div className="bw-stack" style={{ gap: 6 }}>
          <span className="bw-label">Recent calls</span>
          <div className="bw-mini-list">
            {d.calls.map((c) => (
              <div key={c.id} className="it" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div className="bw-row between">
                  <span>{c.caller} · {new Date(c.at).toLocaleString()}</span>
                  <span className="bw-row" style={{ gap: 6 }}>
                    {c.booked ? <span className="bw-badge green">Booked</span> : <span className="bw-badge">No booking</span>}
                    <button type="button" className="bw-btn sm" onClick={() => setShow(show === c.id ? null : c.id)}>{show === c.id ? "Hide" : "Transcript"}</button>
                  </span>
                </div>
                {show === c.id && (
                  <div className="bw-stack" style={{ gap: 4, marginTop: 8 }}>
                    {c.lines.map((l, i) => (
                      <div key={i} style={{ fontSize: 12.5 }}><b>{l.who === "caller" ? "Caller" : "Receptionist"}:</b> {l.text}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
