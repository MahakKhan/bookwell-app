import crypto from "node:crypto";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop, invalidateShop } from "../models/shop.server";
import { decrypt, encrypt } from "../models/crypto.server";
import { isValidTimezone } from "../models/time.server";
import { handleBlockIntent } from "../models/blocks.server";
import { sendEmail, sendSms, sendWhatsapp } from "../models/notify.server";
import { bookPageUrl } from "../models/lifecycle.server";
import { EMAIL_RE } from "../models/submit.server";
import { BlocksEditor, Flash, QuestionRow, useAppLink, useBusy, type Question } from "../components/ui";
import { WIDGET_TEXT } from "../widgetText";
import { googleOAuthUrl, syncGoogleBusy } from "../models/calendar.server";
import { signState } from "../models/crypto.server";
import { zoomConfigured, zoomOAuthUrl } from "../models/zoom.server";

const appUrl = () => (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");

const TABS = [
  ["general", "General settings"],
  ["blocked", "Blocked times"],
  ["design", "Calendar design"],
  ["notifications", "Email & SMS"],
  ["orders", "Orders & refunds"],
  ["questions", "Booking questions"],
  ["translations", "Translations"],
  ["history", "History"],
] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const url = new URL(request.url);
  const tab = TABS.some(([t]) => t === url.searchParams.get("tab")) ? url.searchParams.get("tab")! : "general";
  const channel = url.searchParams.get("channel") || "";

  const [blocks, blockedEmails, questions, logs] = await Promise.all([
    tab === "blocked" ? prisma.blockedTime.findMany({ where: { shopId: shop.id, staffId: null, serviceId: null, resourceId: null }, orderBy: [{ kind: "asc" }, { startDate: "asc" }] }) : [],
    tab === "blocked" ? prisma.blockedEmail.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" } }) : [],
    tab === "questions" ? prisma.bookingQuestion.findMany({ where: { shopId: shop.id, serviceId: null }, orderBy: { position: "asc" } }) : [],
    tab === "history"
      ? prisma.notificationLog.findMany({ where: { shopId: shop.id, ...(channel ? { channel } : {}) }, orderBy: { createdAt: "desc" }, take: 200 })
      : [],
  ]);

  return json({
    tab,
    channel,
    appUrl: appUrl(),
    planName: shop.planName,
    bookPage: bookPageUrl(shop.shopDomain),
    s: {
      timezone: shop.timezone,
      weekStartsOn: shop.weekStartsOn,
      use24h: shop.use24h,
      showStaffSelector: shop.showStaffSelector,
      showSlotsLeft: shop.showSlotsLeft,
      defaultLanguage: shop.defaultLanguage,
      multiLanguage: shop.multiLanguage,
      hideWidgetLogs: shop.hideWidgetLogs,
      dailyBookingLimit: shop.dailyBookingLimit,
      maxPerSlot: shop.maxPerSlot,
      globalBufferMinutes: shop.globalBufferMinutes,
      holdMinutes: shop.holdMinutes,
      widgetAccent: shop.widgetAccent,
      widgetRadius: shop.widgetRadius,
      widgetButtonText: shop.widgetButtonText ?? "",
      allowCustomerCancel: shop.allowCustomerCancel,
      allowCustomerReschedule: shop.allowCustomerReschedule,
      cancelCutoffHours: shop.cancelCutoffHours,
      createOrderWithoutCheckout: shop.createOrderWithoutCheckout,
      autoCancelOrderOnAdminCancel: shop.autoCancelOrderOnAdminCancel,
      autoRefundOnAdminCancel: shop.autoRefundOnAdminCancel,
      autoCancelOrderOnCustomerCancel: shop.autoCancelOrderOnCustomerCancel,
      autoRefundOnCustomerCancel: shop.autoRefundOnCustomerCancel,
      autoCancelBookingOnOrderCancel: shop.autoCancelBookingOnOrderCancel,
      smsEnabled: shop.smsEnabled,
      whatsappEnabled: shop.whatsappEnabled,
      twoWaySyncOn: shop.twoWaySyncOn,
      notifyFromEmail: shop.notifyFromEmail ?? "",
      notifyMerchantEmail: shop.notifyMerchantEmail ?? "",
      emailConfirmSubject: shop.emailConfirmSubject ?? "",
      emailConfirmIntro: shop.emailConfirmIntro ?? "",
      emailReminderHours: shop.emailReminderHours,
      twilioAccountSid: shop.twilioAccountSid ?? "",
      twilioFromNumber: shop.twilioFromNumber ?? "",
      twilioWhatsappFrom: shop.twilioWhatsappFrom ?? "",
      webhookUrl: shop.webhookUrl ?? "",
      webhookSecret: tab === "integrations" ? decrypt(shop.webhookSecret) ?? "" : "",
      apiKeyPrefix: shop.apiKeyPrefix ?? "",
      gaMeasurementId: shop.gaMeasurementId ?? "",
      metaPixelId: shop.metaPixelId ?? "",
      googleBlockBusy: shop.googleBlockBusy,
      textOverrides: (shop.textOverrides ?? {}) as Record<string, Record<string, string>>,
    },
    saved: {
      resendApiKey: Boolean(shop.resendApiKey),
      twilioAuthToken: Boolean(shop.twilioAuthToken),
      klaviyoApiKey: Boolean(shop.klaviyoApiKey),
      google: Boolean(shop.googleRefreshToken),
      zoom: Boolean(shop.zoomRefreshToken),
    },
    oauth: { google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), zoom: zoomConfigured() },
    blocks,
    blockedEmails: blockedEmails.map((b) => ({ id: b.id, email: b.email })),
    questions: questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options.join(", "), required: q.required })),
    logs: logs.map((l) => ({ id: l.id, at: l.createdAt.toISOString(), channel: l.channel, kind: l.kind, to: l.to, subject: l.subject, status: l.status, error: l.error })),
  });
}

const on = (form: FormData, k: string) => form.get(k) === "on";
const optInt = (v: FormDataEntryValue | null, min: number, max: number) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};

export async function action({ request }: ActionFunctionArgs) {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  invalidateShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const f = (k: string) => String(form.get(k) || "").trim();
  const update = (data: Parameters<typeof prisma.shop.update>[0]["data"]) => prisma.shop.update({ where: { id: shop.id }, data });

  const block = await handleBlockIntent(shop.id, form, {});
  if (block) return json(block);

  switch (intent) {
    case "general": {
      if (!isValidTimezone(f("timezone"))) return json({ error: "Unknown timezone. Use an IANA name like America/New_York." }, { status: 400 });
      await update({
        timezone: f("timezone"),
        weekStartsOn: f("weekStartsOn") === "0" ? 0 : 1,
        use24h: on(form, "use24h"),
        showStaffSelector: on(form, "showStaffSelector"),
        showSlotsLeft: on(form, "showSlotsLeft"),
        defaultLanguage: ["en", "es", "fr", "de"].includes(f("defaultLanguage")) ? f("defaultLanguage") : "en",
        multiLanguage: on(form, "multiLanguage"),
        hideWidgetLogs: on(form, "hideWidgetLogs"),
        dailyBookingLimit: on(form, "useDailyLimit") ? optInt(form.get("dailyBookingLimit"), 1, 100_000) : null,
        maxPerSlot: on(form, "useMaxPerSlot") ? optInt(form.get("maxPerSlot"), 1, 100_000) : null,
        globalBufferMinutes: on(form, "useGlobalBuffer") ? optInt(form.get("globalBufferMinutes"), 0, 1440) : null,
      });
      return json({ ok: "Settings saved." });
    }
    case "design": {
      if (!/^#[0-9a-fA-F]{6}$/.test(f("widgetAccent"))) return json({ error: "Pick a valid colour." }, { status: 400 });
      await update({
        widgetAccent: f("widgetAccent"),
        widgetRadius: optInt(form.get("widgetRadius"), 0, 24) ?? 12,
        widgetButtonText: f("widgetButtonText").slice(0, 60) || null,
      });
      return json({ ok: "Design saved. The widget picks it up on the next page load." });
    }
    case "orders": {
      await update({
        createOrderWithoutCheckout: on(form, "createOrderWithoutCheckout"),
        autoCancelOrderOnAdminCancel: on(form, "autoCancelOrderOnAdminCancel"),
        autoRefundOnAdminCancel: on(form, "autoRefundOnAdminCancel"),
        autoCancelOrderOnCustomerCancel: on(form, "autoCancelOrderOnCustomerCancel"),
        autoRefundOnCustomerCancel: on(form, "autoRefundOnCustomerCancel"),
        autoCancelBookingOnOrderCancel: on(form, "autoCancelBookingOnOrderCancel"),
        allowCustomerCancel: on(form, "allowCustomerCancel"),
        allowCustomerReschedule: on(form, "allowCustomerReschedule"),
        cancelCutoffHours: optInt(form.get("cancelCutoffHours"), 0, 24 * 60) ?? 0,
        holdMinutes: optInt(form.get("holdMinutes"), 5, 24 * 60) ?? 30,
      });
      return json({ ok: "Saved." });
    }
    case "notifications": {
      const from = f("notifyFromEmail");
      if (from && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$|^[^<>]+<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/.test(from)) {
        return json({ error: 'The "From" address doesn\'t look valid.' }, { status: 400 });
      }
      const merchant = f("notifyMerchantEmail");
      if (merchant && !EMAIL_RE.test(merchant)) return json({ error: "The notification email doesn't look valid." }, { status: 400 });
      const resendApiKey = f("resendApiKey");
      const twilioAuthToken = f("twilioAuthToken");
      await update({
        notifyFromEmail: from || null,
        notifyMerchantEmail: merchant || null,
        emailConfirmSubject: f("emailConfirmSubject").slice(0, 150) || null,
        emailConfirmIntro: f("emailConfirmIntro").slice(0, 500) || null,
        emailReminderHours: optInt(form.get("emailReminderHours"), 1, 168) ?? 24,
        smsEnabled: on(form, "smsEnabled"),
        whatsappEnabled: on(form, "whatsappEnabled"),
        twilioAccountSid: f("twilioAccountSid") || null,
        twilioFromNumber: f("twilioFromNumber") || null,
        twilioWhatsappFrom: f("twilioWhatsappFrom") || null,
        ...(resendApiKey ? { resendApiKey: encrypt(resendApiKey) } : {}),
        ...(twilioAuthToken ? { twilioAuthToken: encrypt(twilioAuthToken) } : {}),
      });
      return json({ ok: "Notification settings saved." });
    }
    case "clearProviders":
      await update({ resendApiKey: null, twilioAuthToken: null });
      return json({ ok: "Saved API keys removed." });
    case "test": {
      const fresh = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
      const to = f("to");
      const channel = f("channel");
      let ok = false;
      if (channel === "email") {
        if (!EMAIL_RE.test(to)) return json({ error: "Enter an email address to send the test to." }, { status: 400 });
        ok = await sendEmail(fresh, to, "Bookwell test email", "<p>Your Bookwell email settings work.</p>", "test");
      } else if (channel === "sms") {
        ok = await sendSms(fresh, to, "Bookwell test message: your SMS settings work.", "test");
      } else {
        ok = await sendWhatsapp({ ...fresh, whatsappEnabled: true }, to, "Bookwell test message: your WhatsApp settings work.", "test");
      }
      return json(ok ? { ok: "Test sent. Check the History tab for details." } : { error: "The test failed. The History tab shows the provider's error." });
    }
    case "questions": {
      let questions: Question[] = [];
      try {
        questions = JSON.parse(f("questions") || "[]");
      } catch {
        return json({ error: "Invalid questions." }, { status: 400 });
      }
      const keep = questions.filter((q) => q.id).map((q) => q.id!);
      await prisma.bookingQuestion.deleteMany({ where: { shopId: shop.id, serviceId: null, id: { notIn: keep } } });
      for (const [i, q] of questions.entries()) {
        const type = ["text", "textarea", "select", "checkbox"].includes(q.type) ? q.type : "text";
        const row = {
          label: String(q.label || "").trim().slice(0, 200) || "Question",
          type,
          options: type === "select" ? String(q.options || "").split(",").map((o) => o.trim()).filter(Boolean).slice(0, 30) : [],
          required: Boolean(q.required),
          position: i,
        };
        if (q.id) await prisma.bookingQuestion.updateMany({ where: { id: q.id, shopId: shop.id, serviceId: null }, data: row });
        else await prisma.bookingQuestion.create({ data: { ...row, shopId: shop.id } });
      }
      return json({ ok: "Questions saved." });
    }
    case "addBlockedEmail": {
      const email = f("email").toLowerCase();
      if (!EMAIL_RE.test(email) && !/^@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "Enter an email (or @domain.com to block a whole domain)." }, { status: 400 });
      }
      await prisma.blockedEmail.upsert({ where: { shopId_email: { shopId: shop.id, email } }, update: {}, create: { shopId: shop.id, email } });
      return json({ ok: `${email} can no longer book.` });
    }
    case "removeBlockedEmail":
      await prisma.blockedEmail.deleteMany({ where: { id: f("id"), shopId: shop.id } });
      return json({ ok: "Removed." });
    case "integrations": {
      const webhookUrl = f("webhookUrl");
      if (webhookUrl && !/^https:\/\/[^\s]+$/i.test(webhookUrl)) return json({ error: "The webhook URL must start with https://" }, { status: 400 });
      const ga = f("gaMeasurementId");
      if (ga && !/^G-[A-Z0-9]{4,20}$/i.test(ga)) return json({ error: "Google Analytics IDs look like G-XXXXXXX." }, { status: 400 });
      const meta = f("metaPixelId");
      if (meta && !/^\d{5,20}$/.test(meta)) return json({ error: "A Meta Pixel ID is a number." }, { status: 400 });
      const klaviyo = f("klaviyoApiKey");
      await update({
        webhookUrl: webhookUrl || null,
        ...(webhookUrl && !shop.webhookSecret ? { webhookSecret: encrypt(crypto.randomBytes(24).toString("hex")) } : {}),
        gaMeasurementId: ga || null,
        metaPixelId: meta || null,
        ...(klaviyo ? { klaviyoApiKey: encrypt(klaviyo) } : {}),
        twoWaySyncOn: on(form, "twoWaySyncOn"),
        googleBlockBusy: on(form, "googleBlockBusy"),
      });
      if (on(form, "googleBlockBusy")) {
        const fresh = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
        await syncGoogleBusy(fresh).catch(() => 0);
      } else {
        await prisma.externalBusy.deleteMany({ where: { shopId: shop.id } });
      }
      return json({ ok: "Integrations saved." });
    }
    case "translations": {
      const lang = ["en", "es", "fr", "de"].includes(f("lang")) ? f("lang") : "en";
      const current = ((shop.textOverrides ?? {}) as Record<string, Record<string, string>>);
      const next: Record<string, string> = {};
      for (const [key] of WIDGET_TEXT) {
        const v = f(`t_${key}`).slice(0, 300);
        if (v) next[key] = v;
      }
      await update({ textOverrides: { ...current, [lang]: next } });
      return json({ ok: "Texts saved. The widget uses them on the next page load." });
    }
    case "clearKlaviyo":
      await update({ klaviyoApiKey: null });
      return json({ ok: "Klaviyo disconnected." });
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
    case "connectGoogle":
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return json({ error: "Google isn't set up on this app yet: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are empty (see the README)." }, { status: 400 });
      }
      // Google's consent screen can't open inside the admin iframe.
      return redirect(googleOAuthUrl(`${appUrl()}/oauth/google/callback`, signState(shop.shopDomain)), { target: "_top" });
    case "connectZoom":
      if (!zoomConfigured()) {
        return json({ error: "Zoom isn't set up on this app yet: ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET are empty (see the README)." }, { status: 400 });
      }
      return redirect(zoomOAuthUrl(`${appUrl()}/oauth/zoom/callback`, signState(shop.shopDomain)), { target: "_top" });
    case "disconnectZoom":
      await update({ zoomRefreshToken: null, zoomAccessToken: null, zoomTokenExpiry: null });
      return json({ ok: "Zoom disconnected." });
    case "disconnectGoogle":
      await update({ googleRefreshToken: null, googleAccessToken: null, googleTokenExpiry: null, twoWaySyncOn: false });
      return json({ ok: "Google Calendar disconnected." });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const link = useAppLink();
  return (
    <div>
      <div className="bw-head">
        <h1>Settings</h1>
      </div>
      <div className="bw-tabs">
        {TABS.map(([t, label]) => (
          <Link key={t} to={link("/app/settings", { tab: t === "general" ? null : t, channel: null })} className={data.tab === t ? "on" : ""}>
            {label}
          </Link>
        ))}
      </div>
      <Flash data={actionData} />
      {actionData && "apiKey" in actionData && <div className="bw-alert info bw-code">{String(actionData.apiKey)}</div>}
      {data.tab === "general" && <General />}
      {data.tab === "blocked" && <Blocked />}
      {data.tab === "design" && <Design />}
      {data.tab === "notifications" && <Notifications />}
      {data.tab === "orders" && <Orders />}
      {data.tab === "questions" && <Questions />}
      {data.tab === "translations" && <Translations />}
      {data.tab === "history" && <History />}
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

function OptionalNumber({ flag, name, label, value, placeholder, help }: { flag: string; name: string; label: string; value: number | null; placeholder: string; help: string }) {
  const [enabled, setEnabled] = useState(value != null);
  return (
    <div className="bw-stack" style={{ gap: 6 }}>
      <label className="bw-check-row">
        <input type="checkbox" name={flag} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <div>
          <div className="t">{label}</div>
          <div className="s">{help}</div>
        </div>
      </label>
      <input type="number" name={name} min={0} className="bw-input" style={{ maxWidth: 200 }} defaultValue={value ?? ""} placeholder={placeholder} disabled={!enabled} />
    </div>
  );
}

function SaveBar() {
  const busy = useBusy();
  return (
    <div className="bw-sticky-save">
      <button className="bw-btn primary" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function General() {
  const { s } = useLoaderData<typeof loader>();
  return (
    <Form method="post" className="bw-card">
      <input type="hidden" name="intent" value="general" />
      <div className="bw-section">
        <h2>General preferences</h2>
        <div className="bw-grid two" style={{ marginTop: 10 }}>
          <div className="bw-field">
            <label>Store timezone</label>
            <input name="timezone" className="bw-input" defaultValue={s.timezone} />
            <span className="bw-help">Hours, breaks and blocked dates use this timezone. Filled in from Shopify automatically.</span>
          </div>
          <div className="bw-field">
            <label>Calendar first day of week</label>
            <select name="weekStartsOn" className="bw-select" defaultValue={String(s.weekStartsOn)}>
              <option value="1">Monday</option>
              <option value="0">Sunday</option>
            </select>
          </div>
        </div>
        <div className="bw-stack" style={{ marginTop: 14 }}>
          <Toggle name="use24h" title="Use 24-hour time format" checked={s.use24h} />
          <Toggle name="showStaffSelector" title="Show team member selector" sub="If hidden, the first available team member is picked automatically." checked={s.showStaffSelector} />
          <Toggle name="showSlotsLeft" title="Show free spots count in slots" sub="Let customers see how many spots are left in each time slot." checked={s.showSlotsLeft} />
        </div>
      </div>
      <div className="bw-section">
        <h2>Booking limits</h2>
        <div className="bw-grid two" style={{ marginTop: 10 }}>
          <OptionalNumber flag="useDailyLimit" name="dailyBookingLimit" label="Use daily bookings limit" value={s.dailyBookingLimit} placeholder="Unlimited" help="Once reached, nothing can be booked that day, across all services." />
          <OptionalNumber flag="useMaxPerSlot" name="maxPerSlot" label="Maximum bookings per time slot" value={s.maxPerSlot} placeholder="Unlimited" help="E.g. 2 coaches: never more than 2 bookings at the same time, store-wide." />
          <OptionalNumber flag="useGlobalBuffer" name="globalBufferMinutes" label="Use global buffer time (minutes)" value={s.globalBufferMinutes} placeholder="0" help="Minimum gap after every booking; a longer service buffer still wins." />
        </div>
      </div>
      <div className="bw-section">
        <h2>Languages</h2>
        <div className="bw-grid two" style={{ marginTop: 10 }}>
          <div className="bw-field">
            <label>Default language</label>
            <select name="defaultLanguage" className="bw-select" defaultValue={s.defaultLanguage}>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
        </div>
        <div className="bw-stack" style={{ marginTop: 12 }}>
          <Toggle name="multiLanguage" title="Enable multiple languages" sub="The widget follows the visitor's storefront language when it's supported." checked={s.multiLanguage} />
          <Toggle name="hideWidgetLogs" title="Hide widget logs" sub="Turn off to see debugging output from the widget in the browser console." checked={s.hideWidgetLogs} />
        </div>
      </div>
      <SaveBar />
    </Form>
  );
}

function Blocked() {
  const { blocks, blockedEmails, s } = useLoaderData<typeof loader>();
  return (
    <div className="bw-gap">
      <div className="bw-card bw-section">
        <h2>Blocked times</h2>
        <p className="bw-sub">Store-wide breaks, closures and public holidays, in {s.timezone}. Per-person time off lives on the Team page.</p>
        <BlocksEditor blocks={blocks} showHolidays />
      </div>
      <div className="bw-card bw-section">
        <h2>Blocked emails</h2>
        <p className="bw-sub">Stop specific emails (or a whole @domain) from booking.</p>
        <Form method="post" className="bw-row" style={{ marginBottom: 10 }}>
          <input type="hidden" name="intent" value="addBlockedEmail" />
          <input name="email" className="bw-input" style={{ maxWidth: 320 }} placeholder="someone@example.com or @example.com" />
          <button className="bw-btn">+ Add a blocked email</button>
        </Form>
        {blockedEmails.length === 0 ? (
          <div className="bw-dashed">No blocked emails</div>
        ) : (
          <div className="bw-mini-list">
            {blockedEmails.map((b) => (
              <div className="it" key={b.id}>
                {b.email}
                <Form method="post">
                  <input type="hidden" name="intent" value="removeBlockedEmail" />
                  <input type="hidden" name="id" value={b.id} />
                  <button className="bw-btn sm danger">Remove</button>
                </Form>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Design() {
  const { s, bookPage } = useLoaderData<typeof loader>();
  const [accent, setAccent] = useState(s.widgetAccent);
  const [radius, setRadius] = useState(s.widgetRadius);
  const [text, setText] = useState(s.widgetButtonText);
  return (
    <div className="bw-dash-grid">
      <Form method="post" className="bw-card">
        <input type="hidden" name="intent" value="design" />
        <div className="bw-section">
          <h2>Calendar design</h2>
          <div className="bw-stack" style={{ marginTop: 10 }}>
            <div className="bw-field">
              <label>Accent colour</label>
              <div className="bw-row">
                {["#5b5bd6", "#111827", "#0f9d8a", "#2563eb", "#db2777", "#d97706", "#16a34a"].map((c) => (
                  <button key={c} type="button" onClick={() => setAccent(c)} aria-label={c} style={{ width: 28, height: 28, borderRadius: 8, background: c, border: accent === c ? "3px solid var(--fg)" : "1px solid var(--border)", cursor: "pointer" }} />
                ))}
                <input type="color" name="widgetAccent" value={accent} onChange={(e) => setAccent(e.target.value)} />
              </div>
            </div>
            <div className="bw-field">
              <label>Corner roundness: {radius}px</label>
              <input type="range" name="widgetRadius" min={0} max={24} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
            </div>
            <div className="bw-field">
              <label>Book button text</label>
              <input name="widgetButtonText" className="bw-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Book an appointment" maxLength={60} />
            </div>
            <a className="bw-link" href={bookPage} target="_blank" rel="noreferrer">
              Open your booking page →
            </a>
          </div>
        </div>
        <SaveBar />
      </Form>
      <div className="bw-card bw-pad">
        <div className="bw-label" style={{ marginBottom: 10 }}>
          Preview
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: radius, padding: 14 }}>
          <button type="button" style={{ width: "100%", padding: 11, border: "none", borderRadius: radius, background: accent, color: "#fff", fontWeight: 700 }}>
            {text || "Book an appointment"}
          </button>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
            {["09:00", "09:30", "10:00", "10:30"].map((t, i) => (
              <span key={t} style={{ padding: "7px 11px", borderRadius: radius, border: `1px solid ${i === 1 ? accent : "#e1e0f5"}`, background: i === 1 ? accent : "#fff", color: i === 1 ? "#fff" : "#201f3d", fontSize: 12, fontWeight: 600 }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Notifications() {
  const { s, saved } = useLoaderData<typeof loader>();
  return (
    <div className="bw-gap">
      <Form method="post" className="bw-card">
        <input type="hidden" name="intent" value="notifications" />
        <div className="bw-section">
          <h2>Email</h2>
          <p className="bw-sub">Sent through your own Resend account. Keys are stored encrypted and never shown again; leave a key blank to keep the saved one.</p>
          <div className="bw-grid two" style={{ marginTop: 10 }}>
            <div className="bw-field">
              <label>Resend API key</label>
              <input name="resendApiKey" type="password" autoComplete="off" className="bw-input" placeholder={saved.resendApiKey ? "Saved (enter a new key to replace)" : "re_..."} />
            </div>
            <div className="bw-field">
              <label>"From" email address</label>
              <input name="notifyFromEmail" className="bw-input" defaultValue={s.notifyFromEmail} placeholder="Your Store <bookings@yourstore.com>" />
            </div>
            <div className="bw-field">
              <label>Notify me of new bookings at</label>
              <input name="notifyMerchantEmail" type="email" className="bw-input" defaultValue={s.notifyMerchantEmail} placeholder="you@yourstore.com" />
            </div>
            <div className="bw-field">
              <label>Send reminders (hours before)</label>
              <input name="emailReminderHours" type="number" min={1} max={168} className="bw-input" defaultValue={s.emailReminderHours} />
            </div>
            <div className="bw-field">
              <label>Confirmation subject</label>
              <input name="emailConfirmSubject" className="bw-input" defaultValue={s.emailConfirmSubject} placeholder="Booking confirmed: {service}" />
            </div>
            <div className="bw-field">
              <label>Confirmation intro</label>
              <input name="emailConfirmIntro" className="bw-input" defaultValue={s.emailConfirmIntro} placeholder="you're booked in." />
            </div>
          </div>
        </div>
        <div className="bw-section">
          <h2>SMS &amp; WhatsApp</h2>
          <p className="bw-sub">Sent through your own Twilio account. Customers opt in to SMS on the booking form.</p>
          <div className="bw-stack" style={{ marginTop: 10 }}>
            <Toggle name="smsEnabled" title="SMS confirmations and reminders" checked={s.smsEnabled} />
            <Toggle name="whatsappEnabled" title="WhatsApp confirmations and reminders" sub="Needs a WhatsApp-enabled Twilio sender." checked={s.whatsappEnabled} />
          </div>
          <div className="bw-grid two" style={{ marginTop: 12 }}>
            <div className="bw-field">
              <label>Twilio Account SID</label>
              <input name="twilioAccountSid" className="bw-input" defaultValue={s.twilioAccountSid} />
            </div>
            <div className="bw-field">
              <label>Twilio Auth Token</label>
              <input name="twilioAuthToken" type="password" autoComplete="off" className="bw-input" placeholder={saved.twilioAuthToken ? "Saved (enter a new token to replace)" : ""} />
            </div>
            <div className="bw-field">
              <label>SMS "From" number</label>
              <input name="twilioFromNumber" className="bw-input" defaultValue={s.twilioFromNumber} placeholder="+15551234567" />
            </div>
            <div className="bw-field">
              <label>WhatsApp "From" number</label>
              <input name="twilioWhatsappFrom" className="bw-input" defaultValue={s.twilioWhatsappFrom} placeholder="+14155238886" />
            </div>
          </div>
        </div>
        <SaveBar />
      </Form>

      <div className="bw-card bw-section">
        <h2>Send a test</h2>
        <Form method="post" className="bw-row" style={{ marginTop: 10 }}>
          <input type="hidden" name="intent" value="test" />
          <select name="channel" className="bw-select auto">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <input name="to" className="bw-input" style={{ maxWidth: 300 }} placeholder="Email address or +phone" />
          <button className="bw-btn">Send test</button>
        </Form>
        {(saved.resendApiKey || saved.twilioAuthToken) && (
          <Form method="post" style={{ marginTop: 12 }}>
            <input type="hidden" name="intent" value="clearProviders" />
            <button className="bw-btn sm plain" style={{ color: "var(--danger)" }}>
              Remove saved API keys
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}

function Orders() {
  const { s } = useLoaderData<typeof loader>();
  return (
    <Form method="post" className="bw-card">
      <input type="hidden" name="intent" value="orders" />
      <div className="bw-section">
        <h2>Customer self-service</h2>
        <div className="bw-stack" style={{ marginTop: 10 }}>
          <Toggle name="allowCustomerCancel" title="Customers can cancel online" sub="From the link in their confirmation email." checked={s.allowCustomerCancel} />
          <Toggle name="allowCustomerReschedule" title="Customers can reschedule online" checked={s.allowCustomerReschedule} />
          <div className="bw-field" style={{ maxWidth: 260 }}>
            <label>Not later than (hours before the booking)</label>
            <input name="cancelCutoffHours" type="number" min={0} className="bw-input" defaultValue={s.cancelCutoffHours} />
          </div>
        </div>
      </div>
      <div className="bw-section">
        <h2>Payments &amp; orders</h2>
        <div className="bw-stack" style={{ marginTop: 10 }}>
          <div className="bw-field" style={{ maxWidth: 260 }}>
            <label>Hold the slot during checkout for (minutes)</label>
            <input name="holdMinutes" type="number" min={5} className="bw-input" defaultValue={s.holdMinutes} />
            <span className="bw-help">Unpaid checkouts release the slot after this and show up under Bookings → Abandoned.</span>
          </div>
          <Toggle name="createOrderWithoutCheckout" title="Create a Shopify order when a booking is made without checkout" sub="Free/pay-later bookings get a payment-pending order so they appear in Shopify." checked={s.createOrderWithoutCheckout} />
        </div>
      </div>
      <div className="bw-section">
        <h2>Refund and cancellation settings</h2>
        <div className="bw-stack" style={{ marginTop: 10 }}>
          <Toggle name="autoCancelOrderOnAdminCancel" title="Automatically cancel the order when a booking is cancelled by admin" checked={s.autoCancelOrderOnAdminCancel} />
          <Toggle name="autoRefundOnAdminCancel" title="Automatically refund the customer when a booking is cancelled by admin" checked={s.autoRefundOnAdminCancel} />
          <Toggle name="autoCancelOrderOnCustomerCancel" title="Automatically cancel the order when a booking is cancelled by the customer" checked={s.autoCancelOrderOnCustomerCancel} />
          <Toggle name="autoRefundOnCustomerCancel" title="Automatically refund the customer when they cancel their own booking" checked={s.autoRefundOnCustomerCancel} />
          <div className="bw-alert warn" style={{ margin: 0 }}>
            If the order payout has already been sent to your bank, Shopify may not be able to refund it automatically.
          </div>
          <Toggle name="autoCancelBookingOnOrderCancel" title="Automatically cancel the booking when its order is cancelled in Shopify" sub="Checked every 30 minutes." checked={s.autoCancelBookingOnOrderCancel} />
        </div>
      </div>
      <SaveBar />
    </Form>
  );
}

function Questions() {
  const data = useLoaderData<typeof loader>();
  const busy = useBusy();
  const [questions, setQuestions] = useState<Question[]>(data.questions);
  useEffect(() => setQuestions(data.questions), [data.questions]);
  return (
    <Form method="post" className="bw-card">
      <input type="hidden" name="intent" value="questions" />
      <input type="hidden" name="questions" value={JSON.stringify(questions)} />
      <div className="bw-section">
        <div className="bw-row between">
          <div>
            <h2>Booking questions for every service</h2>
            <p className="bw-sub">Name and email are always asked. Add your own: allergies, number of guests, address… Service-specific questions live on each service.</p>
          </div>
          <button type="button" className="bw-btn sm" onClick={() => setQuestions([...questions, { label: "", type: "text", options: "", required: false }])}>
            + Question
          </button>
        </div>
        <div className="bw-stack" style={{ marginTop: 12 }}>
          {questions.length === 0 && <div className="bw-dashed">No custom questions</div>}
          {questions.map((q, i) => (
            <QuestionRow key={q.id ?? `n${i}`} q={q} onChange={(nq) => setQuestions(questions.map((x, j) => (j === i ? nq : x)))} onRemove={() => setQuestions(questions.filter((_, j) => j !== i))} />
          ))}
        </div>
      </div>
      <div className="bw-sticky-save">
        <button className="bw-btn primary" disabled={busy}>
          Save questions
        </button>
      </div>
    </Form>
  );
}

function History() {
  const { logs, channel } = useLoaderData<typeof loader>();
  const link = useAppLink();
  return (
    <div className="bw-card">
      <div className="bw-toolbar">
        {[
          ["", "All"],
          ["email", "Email"],
          ["sms", "SMS"],
          ["whatsapp", "WhatsApp"],
          ["webhook", "Webhooks"],
          ["klaviyo", "Klaviyo"],
        ].map(([c, label]) => (
          <Link key={c} to={link("/app/settings", { tab: "history", channel: c || null })} className={`bw-btn sm${channel === c ? " primary" : ""}`}>
            {label}
          </Link>
        ))}
      </div>
      {logs.length === 0 ? (
        <div className="bw-empty-big">
          <div className="t">Nothing sent yet</div>
          Confirmations, reminders and webhooks appear here.
        </div>
      ) : (
        <div className="bw-table-wrap">
          <table className="bw-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Channel</th>
                <th>Type</th>
                <th>To</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="muted">{new Date(l.at).toLocaleString()}</td>
                  <td>{l.channel}</td>
                  <td>
                    {l.kind}
                    {l.subject ? <div className="muted">{l.subject}</div> : null}
                  </td>
                  <td>{l.to}</td>
                  <td>
                    <span className={`bw-badge ${l.status === "sent" ? "green" : l.status === "failed" ? "red" : ""}`}>{l.status}</span>
                    {l.error ? <div className="muted" style={{ maxWidth: 280 }}>{l.error}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Translations() {
  const { s } = useLoaderData<typeof loader>();
  const busy = useBusy();
  const [lang, setLang] = useState("en");
  const current = s.textOverrides[lang] ?? {};
  return (
    <Form method="post" className="bw-card" key={lang}>
      <input type="hidden" name="intent" value="translations" />
      <input type="hidden" name="lang" value={lang} />
      <div className="bw-section">
        <div className="bw-row between">
          <div>
            <h2>Widget texts</h2>
            <p className="bw-sub">Change any text customers see in the booking widget. Leave a field empty to keep the default.</p>
          </div>
          <select className="bw-select auto" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
          </select>
        </div>
        <div className="bw-grid two" style={{ marginTop: 12 }}>
          {WIDGET_TEXT.map(([key, en]) => (
            <div className="bw-field" key={key}>
              <label>{en}</label>
              <input name={`t_${key}`} className="bw-input" defaultValue={current[key] ?? ""} placeholder={lang === "en" ? en : "Default translation"} />
            </div>
          ))}
        </div>
      </div>
      <div className="bw-sticky-save">
        <button className="bw-btn primary" disabled={busy}>
          Save texts
        </button>
      </div>
    </Form>
  );
}
