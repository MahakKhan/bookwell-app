import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useFetcher, useLoaderData } from "@remix-run/react";
import bookwellStyles from "../styles/bookwell.css?url";
import prisma from "../db.server";
import { InvalidSlotError, SlotTakenError, createBooking, getOpenSlots, isDayService, loadService } from "../models/booking.server";
import { formatBookingWhen, onBookingsCreated } from "../models/lifecycle.server";
import { parseHours } from "../models/blocks.server";
import { EMAIL_RE } from "../models/submit.server";
import { clientIp, rateLimited } from "../models/ratelimit.server";
import { DATE_RE, formatInTz, localParts } from "../models/time.server";
import { Flash, HoursEditor, STATUS_BADGE, STATUS_LABEL, money } from "../components/ui";

// Team portal: a private link (StaffMember.portalToken) a team member opens
// without a Shopify account to see their own bookings and, if the merchant
// allowed it, change their hours or add bookings.
export const links = () => [
  { rel: "stylesheet", href: bookwellStyles },
  { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" },
];
export const meta: MetaFunction = ({ params }) => [
  { title: "Team portal · Bookwell" },
  { name: "robots", content: "noindex" },
  // Installable as a phone app (Add to Home Screen / Install app).
  { tagName: "link", rel: "manifest", href: `/portal-manifest/${params.token}` },
  { tagName: "link", rel: "apple-touch-icon", href: "/app-icon.svg" },
  { name: "theme-color", content: "#5b5bd6" },
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-title", content: "Bookwell" },
];

async function member(token: string) {
  if (!token || token.length < 16) return null;
  return prisma.staffMember.findFirst({
    where: { portalToken: token, portalAccess: true, active: true },
    include: { shop: true, availability: true },
  });
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  if (rateLimited(`portal:${clientIp(request)}`, 60, 60_000)) throw new Response("Too many requests", { status: 429 });
  const m = await member(params.token!);
  if (!m) throw new Response("This link is not valid any more. Ask your manager for a new one.", { status: 404 });
  const shop = m.shop;
  const url = new URL(request.url);

  // Slot lookup for the "new booking" form.
  if (url.searchParams.get("slots") === "1") {
    const service = await loadService(shop.id, url.searchParams.get("serviceId") || "");
    const date = url.searchParams.get("date") || "";
    if (!service || !DATE_RE.test(date) || !m.canCreateBookings) return json({ slots: [] });
    const slots = await getOpenSlots({ shop, service, staffId: service.staffMode === "staff" ? m.id : null, date });
    return json({
      slots: slots.map((s) => ({
        startsAt: s.startsAt.toISOString(),
        available: s.available,
        label: isDayService(service) ? "All day" : formatInTz(s.startsAt, shop.timezone, { hour: "numeric", minute: "2-digit", hour12: !shop.use24h }),
      })),
    });
  }

  const now = new Date();
  const [bookings, services] = await Promise.all([
    prisma.booking.findMany({
      where: { staffId: m.id, status: { in: ["confirmed", "completed", "no_show", "pending"] }, startsAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
      include: { service: { select: { name: true, type: true } } },
      orderBy: { startsAt: "asc" },
      take: 200,
    }),
    m.canCreateBookings
      ? prisma.service.findMany({
          where: {
            shopId: shop.id,
            active: true,
            archived: false,
            ...(m.canBookAnyService ? {} : { staffMode: "staff", OR: [{ staffIds: { isEmpty: true } }, { staffIds: { has: m.id } }] }),
          },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);

  return json({
    name: m.name,
    shopName: shop.shopDomain.replace(".myshopify.com", ""),
    timezone: shop.timezone,
    currency: shop.currency,
    today: localParts(now, shop.timezone).dateStr,
    perms: { hours: m.canEditAvailability, create: m.canCreateBookings, hidePrices: m.hidePrices, hideContact: m.hideContact },
    hours: m.availability,
    services,
    bookings: bookings.map((b) => ({
      id: b.id,
      when: formatBookingWhen(shop, b, b.service),
      upcoming: b.endsAt > now,
      service: b.service.name,
      status: b.status,
      customer: b.customerName,
      email: m.hideContact ? "" : b.customerEmail,
      phone: m.hideContact ? "" : b.customerPhone ?? "",
      quantity: b.quantity,
      price: m.hidePrices ? null : Number(b.totalPrice),
      notes: b.notes ?? "",
      answers: (Array.isArray(b.answers) ? b.answers : []) as { label: string; value: string }[],
    })),
  });
}

export async function action({ params, request }: ActionFunctionArgs) {
  if (rateLimited(`portal-w:${clientIp(request)}`, 20, 60_000)) return json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  const m = await member(params.token!);
  if (!m) return json({ error: "This link is not valid any more." }, { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const f = (k: string) => String(form.get(k) || "").trim();

  if (intent === "hours" && m.canEditAvailability) {
    try {
      const rules = parseHours(form);
      await prisma.$transaction([
        prisma.availabilityRule.deleteMany({ where: { staffId: m.id } }),
        prisma.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, staffId: m.id })) }),
      ]);
      return json({ ok: "Your hours were saved." });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 400 });
    }
  }

  if (intent === "create" && m.canCreateBookings) {
    const service = await loadService(m.shopId, f("serviceId"));
    if (!service || !service.active) return json({ error: "Pick a service." }, { status: 400 });
    if (!m.canBookAnyService && (service.staffMode !== "staff" || (service.staffIds.length > 0 && !service.staffIds.includes(m.id)))) {
      return json({ error: "You can't book that service." }, { status: 403 });
    }
    const email = f("customerEmail").toLowerCase();
    if (!f("customerName") || !EMAIL_RE.test(email)) return json({ error: "Customer name and a valid email are required." }, { status: 400 });
    try {
      const bookings = await createBooking({
        shop: m.shop,
        service,
        staffId: service.staffMode === "staff" ? m.id : null,
        startsAt: f("startsAt") ? new Date(f("startsAt")) : undefined,
        date: f("date"),
        quantity: Number(f("quantity")) || 1,
        customer: { name: f("customerName").slice(0, 120), email, phone: f("customerPhone") || null },
        notes: f("notes") || null,
        source: "portal",
        markPaid: true,
      });
      await onBookingsCreated(m.shop, bookings);
      return json({ ok: "Booking created." });
    } catch (e) {
      if (e instanceof SlotTakenError || e instanceof InvalidSlotError) return json({ error: e.message }, { status: 400 });
      throw e;
    }
  }
  return json({ error: "Not allowed." }, { status: 403 });
}

export default function Portal() {
  const d = useLoaderData<typeof loader>() as Extract<ReturnType<typeof useLoaderData<typeof loader>>, { name: string }>;
  const actionData = useActionData<typeof action>();
  const [tab, setTab] = useState<"upcoming" | "past" | "hours" | "new">("upcoming");
  const list = d.bookings.filter((b) => (tab === "past" ? !b.upcoming : b.upcoming));
  const install = useInstallPrompt();

  return (
    <div className="bw-app">
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px 60px" }}>
        <div className="bw-head">
          <div>
            <h1>Hi {d.name}</h1>
            <p className="bw-sub">
              {d.shopName} · times in {d.timezone}
            </p>
          </div>
          {install.canInstall && (
            <button type="button" className="bw-btn primary" onClick={install.prompt}>
              Install app
            </button>
          )}
        </div>
        {install.iosHint && (
          <div className="bw-alert info">
            Install this as an app: tap the Share button in Safari, then <b>Add to Home Screen</b>.
          </div>
        )}
        <Flash data={actionData} />
        <div className="bw-tabs">
          <button className={tab === "upcoming" ? "on" : ""} onClick={() => setTab("upcoming")}>
            Upcoming <span className="n">{d.bookings.filter((b) => b.upcoming).length}</span>
          </button>
          <button className={tab === "past" ? "on" : ""} onClick={() => setTab("past")}>
            Past 7 days
          </button>
          {d.perms.hours && (
            <button className={tab === "hours" ? "on" : ""} onClick={() => setTab("hours")}>
              My hours
            </button>
          )}
          {d.perms.create && (
            <button className={tab === "new" ? "on" : ""} onClick={() => setTab("new")}>
              New booking
            </button>
          )}
        </div>

        {(tab === "upcoming" || tab === "past") && (
          <div className="bw-card">
            {list.length === 0 ? (
              <div className="bw-empty-big">
                <div className="t">No bookings</div>
              </div>
            ) : (
              list.map((b) => (
                <div key={b.id} className="bw-list-item" style={{ alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div className="bw-row" style={{ gap: 8 }}>
                      <b>{b.when}</b>
                      <span className={`bw-badge ${STATUS_BADGE[b.status] ?? ""}`}>{STATUS_LABEL[b.status] ?? b.status}</span>
                    </div>
                    <div>
                      {b.service} · {b.customer}
                      {b.quantity > 1 ? ` · ${b.quantity} spots` : ""}
                      {b.price != null && b.price > 0 ? ` · ${money(b.price, d.currency)}` : ""}
                    </div>
                    {(b.email || b.phone) && (
                      <div className="bw-help">
                        {b.email}
                        {b.phone ? ` · ${b.phone}` : ""}
                      </div>
                    )}
                    {b.answers.map((a) => (
                      <div key={a.label} className="bw-help">
                        {a.label}: {a.value}
                      </div>
                    ))}
                    {b.notes && <div className="bw-help">Note: {b.notes}</div>}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "hours" && d.perms.hours && (
          <Form method="post" className="bw-card bw-section">
            <input type="hidden" name="intent" value="hours" />
            <h2>My working hours</h2>
            <p className="bw-sub">Customers can only book you inside these hours.</p>
            <HoursEditor rules={d.hours} />
            <div style={{ marginTop: 12 }}>
              <button className="bw-btn primary">Save hours</button>
            </div>
          </Form>
        )}

        {tab === "new" && d.perms.create && <NewBooking services={d.services} today={d.today} />}
      </div>
    </div>
  );
}

function NewBooking({ services, today }: { services: { id: string; name: string }[]; today: string }) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [startsAt, setStartsAt] = useState("");
  const slots = useFetcher<{ slots: { startsAt: string; label: string; available: boolean }[] }>();
  if (!services.length) return <div className="bw-alert info">There are no services you can book.</div>;
  const load = (s: string, dt: string) => {
    setStartsAt("");
    slots.load(`?slots=1&serviceId=${encodeURIComponent(s)}&date=${dt}`);
  };
  return (
    <Form method="post" className="bw-card bw-section bw-stack">
      <input type="hidden" name="intent" value="create" />
      <input type="hidden" name="startsAt" value={startsAt} />
      <div className="bw-grid two">
        <div className="bw-field">
          <label>Service</label>
          <select name="serviceId" className="bw-select" value={serviceId} onChange={(e) => (setServiceId(e.target.value), load(e.target.value, date))}>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="bw-field">
          <label>Date</label>
          <input type="date" name="date" className="bw-input" value={date} min={today} onChange={(e) => (setDate(e.target.value), load(serviceId, e.target.value))} />
        </div>
      </div>
      <div className="bw-field">
        <label>Time</label>
        {!slots.data && slots.state === "idle" ? (
          <button type="button" className="bw-btn sm" onClick={() => load(serviceId, date)}>
            Show times
          </button>
        ) : slots.state !== "idle" ? (
          <span className="bw-help">Loading…</span>
        ) : slots.data!.slots.length === 0 ? (
          <span className="bw-help">No open times that day.</span>
        ) : (
          <div className="bw-slots">
            {slots.data!.slots.map((s) => (
              <button type="button" key={s.startsAt} disabled={!s.available} className={`bw-slot-btn${startsAt === s.startsAt ? " on" : ""}`} onClick={() => setStartsAt(s.startsAt)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="bw-grid two">
        <div className="bw-field">
          <label>Customer name</label>
          <input name="customerName" className="bw-input" required />
        </div>
        <div className="bw-field">
          <label>Customer email</label>
          <input name="customerEmail" type="email" className="bw-input" required />
        </div>
        <div className="bw-field">
          <label>Phone</label>
          <input name="customerPhone" className="bw-input" />
        </div>
        <div className="bw-field">
          <label>Spots</label>
          <input name="quantity" type="number" min={1} defaultValue={1} className="bw-input" />
        </div>
      </div>
      <div className="bw-field">
        <label>Notes</label>
        <textarea name="notes" className="bw-textarea" style={{ minHeight: 60 }} />
      </div>
      <div>
        <button className="bw-btn primary" disabled={!startsAt}>
          Create booking
        </button>
      </div>
    </Form>
  );
}

type InstallEvent = Event & { prompt: () => Promise<void> };

/** "Install app" on Android/desktop Chrome; a hint on iPhone Safari. */
function useInstallPrompt() {
  const [evt, setEvt] = useState<InstallEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/portal-sw.js", { scope: "/portal/" }).catch(() => {});
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (ios && !standalone) setIosHint(true);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  return {
    canInstall: Boolean(evt),
    iosHint,
    prompt: () => {
      evt?.prompt();
      setEvt(null);
    },
  };
}
