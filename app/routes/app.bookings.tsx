import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useFetcher, useLoaderData, useSearchParams, useSubmit } from "@remix-run/react";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { logAccess } from "../models/accessLog.server";
import {
  BookingNotFoundError,
  InvalidSlotError,
  SlotTakenError,
  cancelBookingById,
  createBooking,
  isDayService,
  loadService,
  manageUrlFor,
  rescheduleBooking,
} from "../models/booking.server";
import { formatBookingWhen, onBookingCancelled, onBookingRescheduled, onBookingsCreated, syncPendingPayments } from "../models/lifecycle.server";
import { notifyCustomer } from "../models/notify.server";
import { DATE_RE, addDays, localParts, zonedToUtc } from "../models/time.server";
import { parseTime } from "../models/blocks.server";
import { EMAIL_RE } from "../models/submit.server";
import { Flash, Modal, STATUS_BADGE, STATUS_LABEL, money, useAppLink, useBusy } from "../components/ui";

const TABS = [
  ["upcoming", "Bookings"],
  ["past", "Past"],
  ["pending", "Pre-payment"],
  ["cancelled", "Canceled"],
  ["abandoned", "Abandoned"],
  ["waitlist", "Waitlist"],
] as const;

function tabWhere(tab: string, now: Date): Prisma.BookingWhereInput {
  switch (tab) {
    case "past":
      return { status: { in: ["confirmed", "completed", "no_show"] }, startsAt: { lt: now } };
    case "pending":
      return { status: "pending" };
    case "cancelled":
      return { status: "cancelled" };
    case "abandoned":
      return { status: "abandoned" };
    default:
      return { status: { in: ["confirmed", "completed", "no_show"] }, endsAt: { gte: now } };
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const url = new URL(request.url);
  const p = (k: string) => url.searchParams.get(k) || "";
  const tab = TABS.some(([t]) => t === p("tab")) ? p("tab") : "upcoming";
  const exporting = p("export") === "1";
  const page = Math.max(1, Number(p("page")) || 1);
  const now = new Date();

  // Confirm paid checkouts / release expired holds in the background.
  void syncPendingPayments(shop).catch(() => {});

  const filters: Prisma.BookingWhereInput[] = [];
  const q = p("q").trim();
  if (q) {
    filters.push({
      OR: [
        { customerName: { contains: q, mode: "insensitive" } },
        { customerEmail: { contains: q, mode: "insensitive" } },
        { customerPhone: { contains: q } },
        { service: { name: { contains: q, mode: "insensitive" } } },
        { id: q },
      ],
    });
  }
  if (p("service")) filters.push({ serviceId: p("service") });
  if (p("staff")) filters.push({ staffId: p("staff") });
  if (p("source")) filters.push({ source: p("source") });
  if (DATE_RE.test(p("from"))) filters.push({ startsAt: { gte: zonedToUtc(p("from"), 0, shop.timezone) } });
  if (DATE_RE.test(p("to"))) filters.push({ startsAt: { lt: zonedToUtc(addDays(p("to"), 1), 0, shop.timezone) } });

  const base: Prisma.BookingWhereInput = { shopId: shop.id, AND: filters };
  const where: Prisma.BookingWhereInput = { ...base, ...tabWhere(tab, now) };
  const take = exporting ? 5000 : 50;

  const [bookings, total, counts, services, staff, waitlist] = await Promise.all([
    tab === "waitlist"
      ? Promise.resolve([])
      : prisma.booking.findMany({
          where,
          include: { service: { select: { name: true, type: true } }, staff: { select: { name: true } } },
          orderBy: { startsAt: tab === "upcoming" || tab === "pending" ? "asc" : "desc" },
          take,
          skip: exporting ? 0 : (page - 1) * take,
        }),
    tab === "waitlist" ? Promise.resolve(0) : prisma.booking.count({ where }),
    Promise.all(TABS.filter(([t]) => t !== "waitlist").map(([t]) => prisma.booking.count({ where: { ...base, ...tabWhere(t, now) } }))),
    prisma.service.findMany({ where: { shopId: shop.id }, select: { id: true, name: true, archived: true }, orderBy: { createdAt: "asc" } }),
    prisma.staffMember.findMany({ where: { shopId: shop.id }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } }),
    tab === "waitlist"
      ? prisma.waitlistEntry.findMany({
          where: { shopId: shop.id, status: { in: ["waiting", "notified"] } },
          include: { service: { select: { name: true } } },
          orderBy: [{ date: "asc" }, { createdAt: "asc" }],
          take: 200,
        })
      : Promise.resolve([]),
  ]);
  const waitCount = tab === "waitlist" ? waitlist.length : await prisma.waitlistEntry.count({ where: { shopId: shop.id, status: { in: ["waiting", "notified"] } } });

  const rows = bookings.map((b) => ({
    id: b.id,
    when: formatBookingWhen(shop, b, b.service),
    startsAt: b.startsAt.toISOString(),
    localDate: localParts(b.startsAt, shop.timezone).dateStr,
    status: b.status,
    serviceId: b.serviceId,
    serviceName: b.service.name,
    dayBased: isDayService(b.service),
    staffId: b.staffId,
    staffName: b.staff?.name ?? "",
    customerName: b.customerName,
    customerEmail: b.customerEmail,
    customerPhone: b.customerPhone ?? "",
    quantity: b.quantity,
    totalPrice: Number(b.totalPrice),
    amountDue: Number(b.amountDue),
    paymentStatus: b.paymentStatus,
    source: b.source,
    notes: b.notes ?? "",
    answers: (Array.isArray(b.answers) ? b.answers : []) as { label: string; value: string }[],
    addons: (Array.isArray(b.addons) ? b.addons : []) as { name: string; price: number }[],
    seriesId: b.seriesId,
    shopifyOrderId: b.shopifyOrderId,
    checkoutUrl: b.checkoutUrl,
    manageUrl: manageUrlFor(shop.shopDomain, b.manageToken),
    createdAt: b.createdAt.toISOString(),
  }));

  await logAccess(
    shop.id,
    session,
    exporting ? "bookings.export" : tab === "waitlist" ? "waitlist.view" : "bookings.view",
    tab === "waitlist" ? waitlist.length : rows.length,
    q ? "search" : tab,
  );

  return json({
    tab,
    page,
    total,
    pages: Math.max(1, Math.ceil(total / take)),
    timezone: shop.timezone,
    currency: shop.currency,
    shopDomain: shop.shopDomain,
    today: localParts(now, shop.timezone).dateStr,
    counts: Object.fromEntries([...TABS.filter(([t]) => t !== "waitlist").map(([t], i) => [t, counts[i]]), ["waitlist", waitCount]]),
    services: services.filter((s) => !s.archived),
    allServices: services,
    staff,
    rows,
    waitlist: waitlist.map((w) => ({
      id: w.id,
      service: w.service.name,
      date: w.date,
      name: w.customerName,
      email: w.customerEmail,
      phone: w.customerPhone ?? "",
      status: w.status,
      createdAt: w.createdAt.toISOString(),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const id = String(form.get("id") || "");
  const f = (k: string) => String(form.get(k) || "").trim();

  try {
    if (intent === "cancel") {
      const booking = await cancelBookingById(shop.id, id, "admin");
      if (!booking) return json({ error: "That booking was not found or is already cancelled." }, { status: 404 });
      const { refund } = await onBookingCancelled(shop, id, "admin", { notify: form.get("notify") !== "off" });
      return json({ ok: `Booking cancelled.${refund ? ` ${refund}` : ""}` });
    }

    if (intent === "status") {
      const status = f("status");
      if (!["completed", "no_show", "confirmed"].includes(status)) return json({ error: "Invalid status." }, { status: 400 });
      await prisma.booking.updateMany({ where: { id, shopId: shop.id, status: { in: ["confirmed", "completed", "no_show"] } }, data: { status } });
      return json({ ok: "Status updated." });
    }

    if (intent === "markPaid") {
      await prisma.booking.updateMany({ where: { id, shopId: shop.id }, data: { paymentStatus: "paid" } });
      return json({ ok: "Marked as paid." });
    }

    if (intent === "notes") {
      await prisma.booking.updateMany({ where: { id, shopId: shop.id }, data: { notes: f("notes").slice(0, 2000) || null } });
      return json({ ok: "Notes saved." });
    }

    if (intent === "resend") {
      const b = await prisma.booking.findFirst({ where: { id, shopId: shop.id }, include: { service: true, staff: true } });
      if (!b) return json({ error: "Not found." }, { status: 404 });
      const ok = await notifyCustomer(shop, "confirmation", {
        id: b.id,
        customerEmail: b.customerEmail,
        customerName: b.customerName,
        customerPhone: b.customerPhone,
        serviceName: b.service.name,
        staffName: b.staff?.name,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        allDay: isDayService(b.service),
        quantity: b.quantity,
        manageUrl: manageUrlFor(shop.shopDomain, b.manageToken),
        meetingUrl: b.meetingUrl,
      });
      return json(ok ? { ok: "Confirmation sent." } : { error: "Nothing was sent: set up email in Settings → Notifications." });
    }

    if (intent === "reschedule") {
      const date = f("date");
      if (!DATE_RE.test(date)) return json({ error: "Pick a date." }, { status: 400 });
      const override = form.get("override") === "on";
      let startsAt: Date | undefined = f("startsAt") ? new Date(f("startsAt")) : undefined;
      if (override && f("time")) {
        const m = parseTime(f("time"));
        if (m === null) return json({ error: "Invalid time." }, { status: 400 });
        startsAt = zonedToUtc(date, m, shop.timezone);
      }
      const booking = await rescheduleBooking({
        shop,
        bookingId: id,
        startsAt,
        date,
        endDate: DATE_RE.test(f("endDate")) ? f("endDate") : undefined,
        staffId: f("staffId") ? f("staffId") : undefined,
        ignoreHours: override,
      });
      await onBookingRescheduled(shop, booking.id);
      return json({ ok: "Booking moved." });
    }

    if (intent === "create") {
      const service = await loadService(shop.id, f("serviceId"));
      if (!service) return json({ error: "Pick a service." }, { status: 400 });
      const name = f("customerName").slice(0, 120);
      const email = f("customerEmail").toLowerCase().slice(0, 200);
      if (!name || !EMAIL_RE.test(email)) return json({ error: "Customer name and a valid email are required." }, { status: 400 });
      const date = f("date");
      if (!DATE_RE.test(date)) return json({ error: "Pick a date." }, { status: 400 });
      const override = form.get("override") === "on";
      let startsAt: Date | undefined = f("startsAt") ? new Date(f("startsAt")) : undefined;
      if (!isDayService(service) && (override || !startsAt)) {
        const m = parseTime(f("time"));
        if (m === null) return json({ error: "Pick a time slot (or tick “Any time” and enter one)." }, { status: 400 });
        startsAt = zonedToUtc(date, m, shop.timezone);
      }
      const count = Math.floor(Number(f("repeatCount")) || 0);
      const bookings = await createBooking({
        shop,
        service,
        staffId: f("staffId") || "any",
        startsAt,
        date,
        endDate: DATE_RE.test(f("endDate")) ? f("endDate") : undefined,
        quantity: Number(f("quantity")) || 1,
        addonIds: form.getAll("addonIds").map(String),
        customer: { name, email, phone: f("customerPhone") || null },
        notes: f("notes") || null,
        source: "manual",
        recurrence: count > 1 ? { count, intervalDays: Number(f("repeatEvery")) || 7 } : null,
        ignoreHours: override,
        markPaid: form.get("markPaid") === "on",
      });
      await onBookingsCreated(shop, bookings);
      return json({ ok: bookings.length > 1 ? `${bookings.length} bookings created.` : "Booking created.", created: true });
    }

    if (intent === "waitlistRemove") {
      await prisma.waitlistEntry.updateMany({ where: { id, shopId: shop.id }, data: { status: "removed" } });
      return json({ ok: "Removed from the waitlist." });
    }
  } catch (e) {
    if (e instanceof SlotTakenError || e instanceof InvalidSlotError || e instanceof BookingNotFoundError) {
      return json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

type Row = ReturnType<typeof useLoaderData<typeof loader>>["rows"][number];

export default function Bookings() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params, setParams] = useSearchParams();
  const link = useAppLink();
  const submit = useSubmit();
  const [open, setOpen] = useState<Row | null>(null);
  const [moving, setMoving] = useState<Row | null>(null);
  const [creating, setCreating] = useState(params.get("new") === "1");
  const exporter = useFetcher<typeof loader>();

  useEffect(() => {
    if (actionData && "ok" in actionData) {
      setOpen(null);
      setMoving(null);
      if ("created" in actionData) setCreating(false);
    }
  }, [actionData]);

  useEffect(() => {
    if (exporter.state === "idle" && exporter.data?.rows) downloadCsv(exporter.data.rows, data.tab);
  }, [exporter.state, exporter.data, data.tab]);

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete("page");
    setParams(next);
  };

  return (
    <div>
      <div className="bw-head">
        <h1>
          Bookings <span className="bw-count">{data.counts.upcoming}</span>
        </h1>
        <div className="bw-row">
          <button
            type="button"
            className="bw-btn"
            disabled={exporter.state !== "idle" || data.tab === "waitlist"}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("export", "1");
              exporter.load(`/app/bookings?${next.toString()}`);
            }}
          >
            {exporter.state !== "idle" ? "Exporting…" : "Export CSV"}
          </button>
          <button type="button" className="bw-btn dark" onClick={() => setCreating(true)}>
            + Manual booking
          </button>
        </div>
      </div>
      <Flash data={actionData} />

      <div className="bw-tabs">
        {TABS.map(([t, label]) => (
          <Link key={t} to={link("/app/bookings", { tab: t === "upcoming" ? null : t, page: null })} className={data.tab === t ? "on" : ""}>
            {label} <span className="n">{data.counts[t] ?? 0}</span>
          </Link>
        ))}
      </div>

      <div className="bw-card">
        {data.tab !== "waitlist" && (
          <div className="bw-toolbar">
            <input
              className="bw-input grow"
              placeholder="Filter by customer name, email, phone or service"
              defaultValue={params.get("q") ?? ""}
              onKeyDown={(e) => e.key === "Enter" && setFilter("q", (e.target as HTMLInputElement).value)}
              onBlur={(e) => e.target.value !== (params.get("q") ?? "") && setFilter("q", e.target.value)}
            />
            <select className="bw-select auto" value={params.get("service") ?? ""} onChange={(e) => setFilter("service", e.target.value)}>
              <option value="">All services</option>
              {data.allServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="bw-select auto" value={params.get("staff") ?? ""} onChange={(e) => setFilter("staff", e.target.value)}>
              <option value="">All teammates</option>
              {data.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="bw-select auto" value={params.get("source") ?? ""} onChange={(e) => setFilter("source", e.target.value)}>
              <option value="">All sources</option>
              <option value="widget">Online</option>
              <option value="manual">Manual</option>
              <option value="pos">POS</option>
              <option value="api">API</option>
              <option value="portal">Team portal</option>
              <option value="phone">Phone (AI)</option>
            </select>
            <input type="date" className="bw-input auto" value={params.get("from") ?? ""} onChange={(e) => setFilter("from", e.target.value)} title="From" />
            <input type="date" className="bw-input auto" value={params.get("to") ?? ""} onChange={(e) => setFilter("to", e.target.value)} title="To" />
          </div>
        )}

        {data.tab === "waitlist" ? (
          <WaitlistTable rows={data.waitlist} />
        ) : data.rows.length === 0 ? (
          <div className="bw-empty-big">
            <div className="t">No bookings found</div>
            Try changing the filters or search term.
          </div>
        ) : (
          <div className="bw-table-wrap">
            <table className="bw-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Service</th>
                  <th>Customer</th>
                  <th>Team</th>
                  <th>Qty</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((b) => (
                  <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setOpen(b)}>
                    <td>
                      <b>{b.when}</b>
                      {b.seriesId ? <div className="muted">Recurring</div> : null}
                    </td>
                    <td>{b.serviceName}</td>
                    <td>
                      {b.customerName}
                      <div className="muted">{b.customerEmail}</div>
                    </td>
                    <td>{b.staffName || <span className="muted">—</span>}</td>
                    <td>{b.quantity}</td>
                    <td>
                      {b.totalPrice > 0 ? money(b.totalPrice, data.currency) : "Free"}
                      {b.paymentStatus !== "none" && <div className="muted">{b.paymentStatus === "partial" ? `Deposit ${money(b.amountDue, data.currency)} paid` : b.paymentStatus}</div>}
                    </td>
                    <td>
                      <span className={`bw-badge ${STATUS_BADGE[b.status] ?? ""}`}>{STATUS_LABEL[b.status] ?? b.status}</span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="bw-row" style={{ justifyContent: "flex-end", gap: 6 }}>
                        {["confirmed", "pending"].includes(b.status) && (
                          <button type="button" className="bw-btn sm" onClick={() => setMoving(b)}>
                            Reschedule
                          </button>
                        )}
                        {["confirmed", "pending"].includes(b.status) && (
                          <Form
                            method="post"
                            onSubmit={(e) => {
                              if (!confirm("Cancel this booking? The customer will be notified.")) e.preventDefault();
                            }}
                          >
                            <input type="hidden" name="intent" value="cancel" />
                            <input type="hidden" name="id" value={b.id} />
                            <button className="bw-btn sm danger">Cancel</button>
                          </Form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.pages > 1 && (
          <div className="bw-row" style={{ padding: 12, justifyContent: "center" }}>
            {data.page > 1 && (
              <Link className="bw-btn sm" to={link("/app/bookings", { ...Object.fromEntries(params), page: data.page - 1 })}>
                ← Previous
              </Link>
            )}
            <span className="bw-help">
              Page {data.page} of {data.pages}
            </span>
            {data.page < data.pages && (
              <Link className="bw-btn sm" to={link("/app/bookings", { ...Object.fromEntries(params), page: data.page + 1 })}>
                Next →
              </Link>
            )}
          </div>
        )}
      </div>

      {open && (
        <Modal title={open.serviceName} onClose={() => setOpen(null)} wide>
          <dl className="bw-kv">
            <dt>When</dt>
            <dd>{open.when}</dd>
            <dt>Status</dt>
            <dd>
              <span className={`bw-badge ${STATUS_BADGE[open.status] ?? ""}`}>{STATUS_LABEL[open.status] ?? open.status}</span>
            </dd>
            <dt>Customer</dt>
            <dd>
              {open.customerName} · {open.customerEmail}
              {open.customerPhone ? ` · ${open.customerPhone}` : ""}
            </dd>
            {open.staffName && (
              <>
                <dt>Team member</dt>
                <dd>{open.staffName}</dd>
              </>
            )}
            <dt>Spots</dt>
            <dd>{open.quantity}</dd>
            <dt>Price</dt>
            <dd>
              {money(open.totalPrice, data.currency)}
              {open.amountDue > 0 ? ` (charged online: ${money(open.amountDue, data.currency)})` : ""} · payment {open.paymentStatus}
            </dd>
            {open.addons.length > 0 && (
              <>
                <dt>Add-ons</dt>
                <dd>{open.addons.map((a) => a.name).join(", ")}</dd>
              </>
            )}
            {open.answers.map((a) => (
              <FragmentKV key={a.label} k={a.label} v={a.value} />
            ))}
            <dt>Source</dt>
            <dd>{open.source}</dd>
            {open.shopifyOrderId && (
              <>
                <dt>Shopify order</dt>
                <dd>
                  <a href={`https://${data.shopDomain}/admin/orders/${open.shopifyOrderId.split("/").pop()}`} target="_top">
                    View order
                  </a>
                </dd>
              </>
            )}
            {open.checkoutUrl && open.status === "pending" && (
              <>
                <dt>Checkout link</dt>
                <dd className="bw-code">{open.checkoutUrl}</dd>
              </>
            )}
            <dt>Customer link</dt>
            <dd>
              <a href={open.manageUrl} target="_blank" rel="noreferrer">
                Manage page
              </a>
            </dd>
          </dl>
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="notes" />
            <input type="hidden" name="id" value={open.id} />
            <div className="bw-field">
              <label>Internal notes</label>
              <textarea name="notes" className="bw-textarea" defaultValue={open.notes} />
            </div>
            <div>
              <button className="bw-btn sm">Save notes</button>
            </div>
          </Form>
          <div className="bw-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            {["confirmed", "completed", "no_show"].includes(open.status) && (
              <>
                <StatusButton id={open.id} status="completed" label="Mark completed" />
                <StatusButton id={open.id} status="no_show" label="Mark no-show" />
                {open.status !== "confirmed" && <StatusButton id={open.id} status="confirmed" label="Back to confirmed" />}
              </>
            )}
            {open.paymentStatus !== "paid" && open.totalPrice > 0 && open.status !== "cancelled" && (
              <Form method="post">
                <input type="hidden" name="intent" value="markPaid" />
                <input type="hidden" name="id" value={open.id} />
                <button className="bw-btn sm">Mark paid</button>
              </Form>
            )}
            {open.status === "confirmed" && (
              <Form method="post">
                <input type="hidden" name="intent" value="resend" />
                <input type="hidden" name="id" value={open.id} />
                <button className="bw-btn sm">Resend confirmation</button>
              </Form>
            )}
            {["confirmed", "pending"].includes(open.status) && (
              <>
                <button type="button" className="bw-btn sm" onClick={() => (setMoving(open), setOpen(null))}>
                  Reschedule
                </button>
                <button
                  type="button"
                  className="bw-btn sm danger"
                  onClick={() => {
                    if (confirm("Cancel this booking? The customer will be notified.")) {
                      submit({ intent: "cancel", id: open.id }, { method: "post" });
                    }
                  }}
                >
                  Cancel booking
                </button>
              </>
            )}
          </div>
        </Modal>
      )}

      {moving && <RescheduleModal row={moving} onClose={() => setMoving(null)} today={data.today} />}
      {creating && <ManualBookingModal services={data.services} today={data.today} onClose={() => setCreating(false)} />}
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function StatusButton({ id, status, label }: { id: string; status: string; label: string }) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="status" />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      <button className="bw-btn sm">{label}</button>
    </Form>
  );
}

function WaitlistTable({ rows }: { rows: { id: string; service: string; date: string; name: string; email: string; phone: string; status: string }[] }) {
  if (!rows.length) {
    return (
      <div className="bw-empty-big">
        <div className="t">Nobody on the waitlist</div>
        When a time is full, customers can join the waitlist. They're emailed automatically when a spot frees up.
      </div>
    );
  }
  return (
    <div className="bw-table-wrap">
      <table className="bw-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Service</th>
            <th>Customer</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.id}>
              <td>{w.date}</td>
              <td>{w.service}</td>
              <td>
                {w.name}
                <div className="muted">
                  {w.email}
                  {w.phone ? ` · ${w.phone}` : ""}
                </div>
              </td>
              <td>
                <span className={`bw-badge ${w.status === "notified" ? "blue" : "amber"}`}>{w.status === "notified" ? "Notified" : "Waiting"}</span>
              </td>
              <td>
                <Form method="post">
                  <input type="hidden" name="intent" value="waitlistRemove" />
                  <input type="hidden" name="id" value={w.id} />
                  <button className="bw-btn sm">Remove</button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type SlotsData = {
  service: { id: string; type: string; dayBased: boolean; noStaff?: boolean; capacity: number; maxQuantity: number; allowRecurring: boolean; addons: { id: string; name: string; price: number }[] } | null;
  staff: { id: string; name: string }[];
  slots: { startsAt: string; label: string; available: boolean; seatsLeft: number; staffId: string | null }[];
};

function useSlots(params: Record<string, string | undefined>) {
  const fetcher = useFetcher<SlotsData>();
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!params.serviceId) return;
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    fetcher.load(`/app/slots?${q.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return fetcher;
}

function SlotPicker({ fetcher, value, onChange }: { fetcher: ReturnType<typeof useSlots>; value: string; onChange: (s: { startsAt: string; staffId: string | null }) => void }) {
  if (fetcher.state !== "idle") return <div className="bw-help">Loading times…</div>;
  const slots = fetcher.data?.slots ?? [];
  if (fetcher.data?.service?.noStaff) {
    return <div className="bw-alert err" style={{ margin: 0 }}>No active team member can perform this service. Activate one on the Team page.</div>;
  }
  if (!slots.length) return <div className="bw-help">No open times that day. Tick “Any time” to book outside the schedule.</div>;
  return (
    <div className="bw-slots">
      {slots.map((s) => (
        <button
          type="button"
          key={s.startsAt}
          className={`bw-slot-btn${value === s.startsAt ? " on" : ""}`}
          disabled={!s.available}
          onClick={() => onChange({ startsAt: s.startsAt, staffId: s.staffId })}
          title={s.available ? `${s.seatsLeft} spot(s) left` : "Full"}
        >
          {s.label}
          {s.available && s.seatsLeft > 1 && s.seatsLeft < 1000 ? ` · ${s.seatsLeft}` : ""}
        </button>
      ))}
    </div>
  );
}

function RescheduleModal({ row, onClose, today }: { row: Row; onClose: () => void; today: string }) {
  const busy = useBusy();
  const [date, setDate] = useState(row.localDate >= today ? row.localDate : today);
  const [slot, setSlot] = useState<{ startsAt: string; staffId: string | null } | null>(null);
  const [override, setOverride] = useState(false);
  const fetcher = useSlots({ serviceId: row.serviceId, staffId: row.staffId ?? "", date, excludeBookingId: row.id, quantity: String(row.quantity) });

  return (
    <Modal title={`Reschedule · ${row.customerName}`} onClose={onClose}>
      <Form method="post" className="bw-stack">
        <input type="hidden" name="intent" value="reschedule" />
        <input type="hidden" name="id" value={row.id} />
        <input type="hidden" name="startsAt" value={slot?.startsAt ?? ""} />
        <div className="bw-field">
          <label>New date</label>
          <input type="date" name="date" className="bw-input" value={date} onChange={(e) => (setDate(e.target.value), setSlot(null))} />
        </div>
        {row.dayBased ? (
          <div className="bw-help">Day-based booking: it keeps the same number of days.</div>
        ) : override ? (
          <div className="bw-field">
            <label>Time</label>
            <input type="time" name="time" className="bw-input" required />
          </div>
        ) : (
          <SlotPicker fetcher={fetcher} value={slot?.startsAt ?? ""} onChange={setSlot} />
        )}
        <label className="bw-check-row">
          <input type="checkbox" name="override" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          <div>
            <div className="t">Any time (ignore opening hours and blocked dates)</div>
            <div className="s">Double-booking protection still applies.</div>
          </div>
        </label>
        <div className="bw-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="bw-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="bw-btn primary" disabled={busy || (!row.dayBased && !override && !slot)}>
            Move booking
          </button>
        </div>
      </Form>
    </Modal>
  );
}

function ManualBookingModal({ services, today, onClose }: { services: { id: string; name: string }[]; today: string; onClose: () => void }) {
  const busy = useBusy();
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [staffId, setStaffId] = useState("");
  const [date, setDate] = useState(today);
  const [quantity, setQuantity] = useState(1);
  const [slot, setSlot] = useState<{ startsAt: string; staffId: string | null } | null>(null);
  const [override, setOverride] = useState(false);
  const fetcher = useSlots({ serviceId, staffId, date, quantity: String(quantity) });
  const svc = fetcher.data?.service;
  const effectiveStaff = staffId || slot?.staffId || "";
  const customers = useFetcher<{ customers: { name: string; email: string; phone: string | null }[] }>();
  const datalist = useMemo(() => customers.data?.customers ?? [], [customers.data]);

  if (!services.length) {
    return (
      <Modal title="Manual booking" onClose={onClose}>
        <div className="bw-alert info">Create a service first.</div>
      </Modal>
    );
  }

  return (
    <Modal title="Manual booking" onClose={onClose} wide>
      <Form method="post" className="bw-stack">
        <input type="hidden" name="intent" value="create" />
        <input type="hidden" name="startsAt" value={slot?.startsAt ?? ""} />
        <input type="hidden" name="staffId" value={effectiveStaff} />
        <div className="bw-grid two">
          <div className="bw-field">
            <label>Service</label>
            <select name="serviceId" className="bw-select" value={serviceId} onChange={(e) => (setServiceId(e.target.value), setStaffId(""), setSlot(null))}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          {fetcher.data?.staff && fetcher.data.staff.length > 0 && (
            <div className="bw-field">
              <label>Team member</label>
              <select className="bw-select" value={staffId} onChange={(e) => (setStaffId(e.target.value), setSlot(null))}>
                <option value="">Any available</option>
                {fetcher.data.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="bw-field">
            <label>{svc?.type === "multiday" ? "Start date" : "Date"}</label>
            <input type="date" name="date" className="bw-input" value={date} onChange={(e) => (setDate(e.target.value), setSlot(null))} required />
          </div>
          {svc?.type === "multiday" && (
            <div className="bw-field">
              <label>End date</label>
              <input type="date" name="endDate" className="bw-input" min={date} defaultValue={date} />
            </div>
          )}
          <div className="bw-field">
            <label>Spots</label>
            <input type="number" name="quantity" className="bw-input" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
          </div>
        </div>

        {!svc?.dayBased && (
          <div className="bw-field">
            <label>Time</label>
            {override ? <input type="time" name="time" className="bw-input" required /> : <SlotPicker fetcher={fetcher} value={slot?.startsAt ?? ""} onChange={setSlot} />}
          </div>
        )}
        <label className="bw-check-row">
          <input type="checkbox" name="override" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          <div>
            <div className="t">Any time (ignore opening hours, blocked dates and limits)</div>
            <div className="s">Double-booking protection still applies.</div>
          </div>
        </label>

        {svc && svc.addons.length > 0 && (
          <div className="bw-field">
            <label>Add-ons</label>
            <div className="bw-row">
              {svc.addons.map((a) => (
                <label key={a.id} className="bw-check-row" style={{ marginRight: 10 }}>
                  <input type="checkbox" name="addonIds" value={a.id} /> {a.name}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="bw-grid two">
          <div className="bw-field">
            <label>Customer email</label>
            <input
              name="customerEmail"
              type="email"
              className="bw-input"
              list="bw-customers"
              required
              onFocus={() => customers.state === "idle" && !customers.data && customers.load("/app/customers?list=1")}
              onChange={(e) => {
                const c = datalist.find((x) => x.email === e.target.value);
                if (c) {
                  const formEl = e.target.form!;
                  (formEl.elements.namedItem("customerName") as HTMLInputElement).value = c.name;
                  (formEl.elements.namedItem("customerPhone") as HTMLInputElement).value = c.phone ?? "";
                }
              }}
            />
            <datalist id="bw-customers">
              {datalist.map((c) => (
                <option key={c.email} value={c.email}>
                  {c.name}
                </option>
              ))}
            </datalist>
          </div>
          <div className="bw-field">
            <label>Customer name</label>
            <input name="customerName" className="bw-input" required />
          </div>
          <div className="bw-field">
            <label>Phone (optional)</label>
            <input name="customerPhone" className="bw-input" />
          </div>
          <div className="bw-field">
            <label>Repeat</label>
            <div className="bw-row">
              <select name="repeatEvery" className="bw-select auto" defaultValue="7">
                <option value="7">Weekly</option>
                <option value="14">Every 2 weeks</option>
                <option value="28">Every 4 weeks</option>
                <option value="1">Daily</option>
              </select>
              <input name="repeatCount" type="number" min={1} max={52} defaultValue={1} className="bw-input auto" style={{ width: 70 }} title="Number of sessions" />
              <span className="bw-help">sessions</span>
            </div>
          </div>
        </div>
        <div className="bw-field">
          <label>Notes</label>
          <textarea name="notes" className="bw-textarea" style={{ minHeight: 60 }} />
        </div>
        <div className="bw-row">
          <label className="bw-check-row">
            <input type="checkbox" name="markPaid" /> Already paid
          </label>
        </div>
        <div className="bw-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="bw-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="bw-btn primary" disabled={busy || (!svc?.dayBased && !override && !slot)}>
            {busy ? "Booking…" : "Create booking"}
          </button>
        </div>
      </Form>
    </Modal>
  );
}

function downloadCsv(rows: Row[], tab: string) {
  const header = ["Booking ID", "When", "Status", "Service", "Team member", "Customer", "Email", "Phone", "Spots", "Total", "Charged online", "Payment", "Source", "Add-ons", "Answers", "Notes", "Created"];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((b) =>
    [
      b.id,
      b.when,
      b.status,
      b.serviceName,
      b.staffName,
      b.customerName,
      b.customerEmail,
      b.customerPhone,
      b.quantity,
      b.totalPrice,
      b.amountDue,
      b.paymentStatus,
      b.source,
      b.addons.map((a) => a.name).join("; "),
      b.answers.map((a) => `${a.label}: ${a.value}`).join("; "),
      b.notes,
      b.createdAt,
    ]
      .map(esc)
      .join(","),
  );
  const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bookwell-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
