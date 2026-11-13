import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { unbookableServices } from "../models/booking.server";
import { unlinkProduct } from "../models/metafield.server";
import { bookPageUrl } from "../models/lifecycle.server";
import { AiUnavailableError, aiAvailable, draftServiceFromDescription } from "../models/ai.server";
import { parseTime } from "../models/blocks.server";
import { PAYMENT_LABEL, PRESETS, TYPE_LABEL } from "../presets";
import { Flash, Modal, money, useAppLink, useBusy, ServicesTabs } from "../components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const [services, unbookable] = await Promise.all([prisma.service.findMany({
    where: { shopId: shop.id },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { bookings: true } }, resource: { select: { name: true } } },
  }), unbookableServices(shop.id)]);
  const problems = new Map(unbookable.map((u) => [u.id, u.reason]));
  return json({
    planName: shop.planName,
    currency: shop.currency,
    atLimit: false,
    bookPage: bookPageUrl(shop.shopDomain),
    aiReady: aiAvailable(),
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      color: s.color,
      durationMinutes: s.durationMinutes,
      price: Number(s.price),
      capacity: s.capacity,
      paymentMode: s.paymentMode,
      productId: s.productId,
      active: s.active,
      archived: s.archived,
      resource: s.resource?.name ?? null,
      bookings: s._count.bookings,
      bookUrl: bookPageUrl(shop.shopDomain, s.id),
      problem: problems.get(s.id) ?? null,
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin, redirect } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "ai") {
    const description = String(form.get("description") || "").trim().slice(0, 2000);
    if (description.length < 10) return json({ error: "Describe your service in a sentence or two." }, { status: 400 });
    try {
      const d = await draftServiceFromDescription(description, shop.currency);
      const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
      const dayBased = d.type === "fullday" || d.type === "multiday";
      const staffMode = dayBased ? "none" : d.staffMode;
      const capacity = clampInt(d.capacity, 1, 10_000);
      const service = await prisma.service.create({
        data: {
          shopId: shop.id,
          active: false, // a draft: the merchant reviews it, then activates
          name: d.name.slice(0, 120) || "New service",
          description: d.description.slice(0, 2000) || null,
          type: d.type,
          durationMinutes: dayBased ? 1440 : clampInt(d.durationMinutes, 5, 1440),
          price: Math.max(0, Math.round((Number(d.price) || 0) * 100) / 100),
          bufferMinutes: clampInt(d.bufferMinutes, 0, 480),
          capacity,
          maxQuantity: Math.min(capacity, clampInt(d.maxQuantity, 1, 10_000)),
          staffMode,
          paymentMode: d.paymentMode,
          depositValue: Math.max(0, Number(d.depositValue) || 0),
          minDays: clampInt(d.minDays, 1, 365),
          maxDays: Math.max(clampInt(d.minDays, 1, 365), clampInt(d.maxDays, 1, 365)),
          allowRecurring: d.allowRecurring && !dayBased,
          waitlistEnabled: d.waitlistEnabled,
        },
      });
      if (staffMode === "none") {
        const hours = d.openingHours
          .map((h) => ({ weekday: clampInt(h.weekday, 0, 6), startMinute: parseTime(h.start) ?? -1, endMinute: h.end === "24:00" ? 1440 : (parseTime(h.end) ?? -1) }))
          .filter((h) => h.startMinute >= 0 && h.endMinute > h.startMinute);
        const rules = hours.length ? hours : [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: dayBased ? 0 : 540, endMinute: dayBased ? 1440 : 1020 }));
        await prisma.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, serviceId: service.id })) });
      }
      if (d.addons.length) {
        await prisma.serviceAddon.createMany({
          data: d.addons.slice(0, 6).map((a, i) => ({ serviceId: service.id, name: a.name.slice(0, 120), price: Math.max(0, Number(a.price) || 0), durationMinutes: dayBased ? 0 : clampInt(a.durationMinutes, 0, 480), position: i })),
        });
      }
      if (d.questions.length) {
        await prisma.bookingQuestion.createMany({
          data: d.questions.slice(0, 6).map((q, i) => ({ shopId: shop.id, serviceId: service.id, label: q.label.slice(0, 200), type: q.type, options: q.type === "select" ? q.options.slice(0, 30) : [], required: q.required, position: i })),
        });
      }
      return redirect(`/app/services/${service.id}?ai=1`);
    } catch (e) {
      if (e instanceof Response) throw e;
      return json({ error: (e as Error).message }, { status: e instanceof AiUnavailableError ? 503 : 502 });
    }
  }
  const id = String(form.get("id") || "");
  const service = await prisma.service.findFirst({ where: { id, shopId: shop.id }, include: { addons: true } });
  if (!service) return json({ error: "Service not found." }, { status: 404 });

  if (intent === "toggle") {
    await prisma.service.update({ where: { id }, data: { active: !service.active } });
    return json({ ok: service.active ? "Service paused: it can't be booked." : "Service is bookable again." });
  }
  if (intent === "archive") {
    await prisma.service.update({ where: { id }, data: { archived: !service.archived, active: service.archived } });
    return json({ ok: service.archived ? "Service restored." : "Service archived." });
  }
  if (intent === "duplicate") {
    const { id: _id, createdAt: _c, productId: _p, addons, ...rest } = service;
    const copy = await prisma.service.create({ data: { ...rest, name: `${service.name} (copy)` } });
    if (addons.length) {
      await prisma.serviceAddon.createMany({
        data: addons.map(({ id: _a, serviceId: _s, ...a }) => ({ ...a, serviceId: copy.id })),
      });
    }
    const rules = await prisma.availabilityRule.findMany({ where: { serviceId: id } });
    if (rules.length) {
      await prisma.availabilityRule.createMany({
        data: rules.map((r) => ({ serviceId: copy.id, weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
      });
    }
    return json({ ok: "Service duplicated." });
  }
  if (intent === "delete") {
    const bookings = await prisma.booking.count({ where: { serviceId: id } });
    if (bookings > 0) {
      await prisma.service.update({ where: { id }, data: { archived: true, active: false } });
      return json({ ok: true, warning: "This service has bookings, so it was archived instead of deleted to keep their history." });
    }
    await prisma.service.delete({ where: { id } });
    if (service.productId) await unlinkProduct(admin, service.productId).catch(() => {});
    return json({ ok: "Service deleted." });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

export default function Services() {
  const { services, atLimit, currency, bookPage, aiReady } = useLoaderData<typeof loader>();
  const busy = useBusy();
  const actionData = useActionData<typeof action>();
  const [params] = useSearchParams();
  const link = useAppLink();
  const archivedTab = params.get("tab") === "archived";
  const [picking, setPicking] = useState(params.get("new") === "1");
  const list = services.filter((s) => s.archived === archivedTab);

  return (
    <div>
      <ServicesTabs />
      <div className="bw-head">
        <div className="bw-row" style={{ gap: 16 }}>
          <h1>
            My services <span className="bw-count">{services.filter((s) => !s.archived).length}</span>
          </h1>
        </div>
        <div className="bw-row">
          <a className="bw-btn" href={bookPage} target="_blank" rel="noreferrer">
            View booking page
          </a>
          <button type="button" className="bw-btn dark" onClick={() => setPicking(true)} disabled={atLimit}>
            + New service
          </button>
        </div>
      </div>
      <Flash data={actionData} />

      <div className="bw-row" style={{ marginBottom: 14, gap: 6 }}>
        <Link to={link("/app/services", { tab: null })} className={`bw-btn sm${!archivedTab ? " primary" : ""}`}>
          All
        </Link>
        <Link to={link("/app/services", { tab: "archived" })} className={`bw-btn sm${archivedTab ? " primary" : ""}`}>
          Archived ({services.filter((s) => s.archived).length})
        </Link>
      </div>

      <div className="bw-card">
        {list.length === 0 ? (
          <div className="bw-empty-big">
            <div className="t">{archivedTab ? "No archived services" : "Create & manage your booking pages"}</div>
            {!archivedTab && (
              <>
                <p>Pick a service type to start from. You can change everything later.</p>
                <button type="button" className="bw-btn dark" onClick={() => setPicking(true)} disabled={atLimit}>
                  Create a service
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="bw-table-wrap">
            <table className="bw-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Type</th>
                  <th>Price</th>
                  <th>Payment</th>
                  <th>Product</th>
                  <th>Bookings</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="bw-row" style={{ gap: 8 }}>
                        <span className="bw-dot" style={{ background: s.color }} />
                        <div>
                          <Link to={link(`/app/services/${s.id}`)} style={{ fontWeight: 600, color: "var(--fg)" }}>
                            {s.name}
                          </Link>
                          {s.problem && <div className="bw-badge red" style={{ margin: "3px 0" }}>Can't be booked: {s.problem.toLowerCase()}</div>}
                          <div className="muted">
                            {s.type === "fullday" || s.type === "multiday" ? "Day-based" : `${s.durationMinutes} min`}
                            {s.capacity > 1 ? ` · ${s.capacity} spots` : ""}
                            {s.resource ? ` · ${s.resource}` : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="bw-badge blue">{TYPE_LABEL[s.type] ?? s.type}</span>
                    </td>
                    <td>{s.price > 0 ? money(s.price, currency) : "Free"}</td>
                    <td className="muted">{PAYMENT_LABEL[s.paymentMode]}</td>
                    <td>
                      {s.productId ? <span className="bw-badge green">Linked</span> : <span className="bw-badge amber">Booking page only</span>}
                    </td>
                    <td>{s.bookings}</td>
                    <td>
                      <div className="bw-row" style={{ justifyContent: "flex-end", gap: 6 }}>
                        {!s.archived && (
                          <Form method="post">
                            <input type="hidden" name="intent" value="toggle" />
                            <input type="hidden" name="id" value={s.id} />
                            <button className={`bw-badge ${s.active ? "green" : ""}`} style={{ border: "none", cursor: "pointer" }} title="Toggle bookable">
                              {s.active ? "Active" : "Paused"}
                            </button>
                          </Form>
                        )}
                        <Link className="bw-btn sm" to={link(`/app/services/${s.id}`)}>
                          Edit
                        </Link>
                        <details className="bw-menu">
                          <summary className="bw-btn sm" aria-label="More actions">
                            ⋯
                          </summary>
                          <div className="bw-menu-list">
                            <a href={s.bookUrl} target="_blank" rel="noreferrer">
                              Preview booking page
                            </a>
                            <Form method="post">
                              <input type="hidden" name="intent" value="duplicate" />
                              <input type="hidden" name="id" value={s.id} />
                              <button disabled={atLimit}>Duplicate</button>
                            </Form>
                            <Form method="post">
                              <input type="hidden" name="intent" value="archive" />
                              <input type="hidden" name="id" value={s.id} />
                              <button>{s.archived ? "Restore" : "Archive"}</button>
                            </Form>
                            <Form
                              method="post"
                              onSubmit={(e) => {
                                if (!confirm(`Delete "${s.name}"?`)) e.preventDefault();
                              }}
                            >
                              <input type="hidden" name="intent" value="delete" />
                              <input type="hidden" name="id" value={s.id} />
                              <button className="danger">Delete</button>
                            </Form>
                          </div>
                        </details>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {picking && (
        <Modal title="Choose a service type or a preset" onClose={() => setPicking(false)} wide>
          <p className="bw-sub" style={{ margin: 0 }}>
            Pick a starting point. You can customise everything afterwards.
          </p>
          <Form method="post" className="bw-card bw-pad bw-stack" style={{ background: "var(--accent-soft)", gap: 8 }}>
            <input type="hidden" name="intent" value="ai" />
            <b>✨ Create your service with AI</b>
            <span className="bw-help">Describe what you sell in your own words. AI sets up the service (type, duration, price, hours, add-ons, questions) as a paused draft for you to review.</span>
            <textarea name="description" className="bw-textarea" style={{ minHeight: 70 }} placeholder="e.g. 45-minute deep tissue massage for $80, optional hot stones for $15, we need to know about injuries" disabled={!aiReady} />
            <div className="bw-row">
              <button className="bw-btn primary" disabled={!aiReady || busy}>
                {busy ? "Setting it up…" : "Create with AI"}
              </button>
              {!aiReady && <span className="bw-help">Needs ANTHROPIC_API_KEY in the app's environment.</span>}
            </div>
          </Form>
          <div className="bw-label">Basic modes</div>
          <div className="bw-types">
            {PRESETS.filter((p) => p.group === "basic").map((p) => (
              <Link key={p.key} className="bw-type" to={link("/app/services/new", { preset: p.key })}>
                <div className="ic">{p.icon}</div>
                <div className="t">{p.title}</div>
                <div className="s">{p.blurb}</div>
              </Link>
            ))}
          </div>
          <div className="bw-label" style={{ marginTop: 8 }}>
            Preset services
          </div>
          <div className="bw-types">
            {PRESETS.filter((p) => p.group === "preset").map((p) => (
              <Link key={p.key} className="bw-type" to={link("/app/services/new", { preset: p.key })}>
                <div className="ic">{p.icon}</div>
                <div className="t">{p.title}</div>
                <div className="s">{p.blurb}</div>
              </Link>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
