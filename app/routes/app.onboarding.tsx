import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useRevalidator } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop, invalidateShop } from "../models/shop.server";
import { onboardingState } from "../models/onboarding.server";
import { parseHours } from "../models/blocks.server";
import { linkProductToService } from "../models/metafield.server";
import { bookPageUrl } from "../models/lifecycle.server";
import { PRESETS } from "../presets";
import { Flash, HoursEditor, useAppLink, useBusy } from "../components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const state = await onboardingState(shop, admin);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const editor = `https://${shop.shopDomain}/admin/themes/current/editor`;
  const firstService = state.services[0] ?? null;
  const staffService = state.services.find((s) => s.staffMode === "staff") ?? null;
  const hoursRules = firstService && firstService.staffMode === "none"
    ? await prisma.availabilityRule.findMany({ where: { serviceId: firstService.id } })
    : [];
  return json({
    shopName: shop.shopDomain.replace(".myshopify.com", ""),
    timezone: shop.timezone,
    steps: state.steps,
    theme: state.theme,
    unbookable: state.unbookable,
    services: state.services,
    firstService,
    needsStaff: Boolean(staffService),
    staff: state.staff.map((m) => ({ id: m.id, name: m.name, active: m.active, availability: m.availability })),
    serviceHours: hoursRules,
    links: {
      addBlock: `${editor}?template=product&addAppBlockId=${apiKey}/booking&target=mainSection`,
      embed: `${editor}?context=apps&activateAppId=${apiKey}/embed`,
      bookPage: bookPageUrl(shop.shopDomain),
      firstServicePage: firstService ? bookPageUrl(shop.shopDomain, firstService.id) : null,
    },
    notifications: { email: Boolean(shop.resendApiKey && shop.notifyFromEmail), sms: shop.smsEnabled, whatsapp: shop.whatsappEnabled },
  });
}

const BASIC_KEYS = ["regular", "group", "virtual", "fullday", "multiday", "prepay", "court", "ticket"];

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const f = (k: string) => String(form.get(k) || "").trim();

  if (intent === "createService") {
    const preset = PRESETS.find((p) => p.key === f("preset")) ?? PRESETS[0];
    const v = preset.values;
    const name = f("name").slice(0, 120) || v.name || "My service";
    const dayBased = v.type === "fullday" || v.type === "multiday";
    const productId = f("productId") || null;
    if (productId && !/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) return json({ error: "Invalid product." }, { status: 400 });
    const service = await prisma.service.create({
      data: {
        shopId: shop.id,
        name,
        type: v.type ?? "appointment",
        durationMinutes: dayBased ? 1440 : Math.min(1440, Math.max(5, Math.round(Number(f("duration")) || v.durationMinutes || 60))),
        price: Math.max(0, Math.round((Number(f("price")) || 0) * 100) / 100),
        bufferMinutes: v.bufferMinutes ?? 0,
        capacity: v.capacity ?? 1,
        maxQuantity: v.maxQuantity ?? 1,
        slotStepMinutes: v.slotStepMinutes ?? null,
        staffMode: dayBased ? "none" : (v.staffMode ?? "staff"),
        paymentMode: v.paymentMode ?? "none",
        depositValue: v.depositValue ?? 0,
        allowRecurring: v.allowRecurring ?? false,
        maxRecurrences: v.maxRecurrences ?? 8,
        minDays: v.minDays ?? 1,
        maxDays: v.maxDays ?? 14,
        productId,
      },
    });
    if (service.staffMode === "none") {
      await prisma.availabilityRule.createMany({
        data: (dayBased ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]).map((weekday) => ({
          serviceId: service.id,
          weekday,
          startMinute: dayBased ? 0 : 540,
          endMinute: dayBased ? 1440 : 1020,
        })),
      });
    }
    if (productId) {
      try {
        await linkProductToService(admin, productId, service.id);
      } catch (e) {
        return json({ ok: true, warning: `Service created, but linking the product failed: ${(e as Error).message}` });
      }
    }
    return json({ ok: `“${name}” created.` });
  }

  if (intent === "availability") {
    let rules;
    try {
      rules = parseHours(form);
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 400 });
    }
    if (!rules.length) return json({ error: "Open at least one day." }, { status: 400 });
    if (f("serviceId")) {
      const svc = await prisma.service.findFirst({ where: { id: f("serviceId"), shopId: shop.id } });
      if (!svc) return json({ error: "Service not found." }, { status: 404 });
      await prisma.$transaction([
        prisma.availabilityRule.deleteMany({ where: { serviceId: svc.id } }),
        prisma.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, serviceId: svc.id })) }),
      ]);
      return json({ ok: "Opening hours saved." });
    }
    let staffId = f("staffId");
    if (staffId) {
      const m = await prisma.staffMember.findFirst({ where: { id: staffId, shopId: shop.id } });
      if (!m) return json({ error: "Team member not found." }, { status: 404 });
      await prisma.staffMember.update({ where: { id: m.id }, data: { active: true } });
    } else {
      const name = f("staffName").slice(0, 120);
      if (!name) return json({ error: "Enter who performs the service (it can be you)." }, { status: 400 });
      const created = await prisma.staffMember.create({ data: { shopId: shop.id, name, email: f("staffEmail").toLowerCase() || null } });
      staffId = created.id;
    }
    await prisma.$transaction([
      prisma.availabilityRule.deleteMany({ where: { staffId } }),
      prisma.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, staffId })) }),
    ]);
    return json({ ok: "Working hours saved." });
  }

  if (intent === "finish" || intent === "dismiss") {
    await prisma.shop.update({ where: { id: shop.id }, data: { onboardingDoneAt: new Date() } });
    invalidateShop(session.shop);
    return json({ ok: intent === "finish" ? "Setup complete. You're ready to take bookings!" : "Setup guide hidden. Reopen it any time from the sidebar.", finished: true });
  }
  if (intent === "reopen") {
    await prisma.shop.update({ where: { id: shop.id }, data: { onboardingDoneAt: null } });
    invalidateShop(session.shop);
    return json({ ok: "Setup guide reopened." });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

export default function Onboarding() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const link = useAppLink();
  const order = ["installed", "service", "availability", "widget", "testBooking", "finished"] as const;
  const firstOpen = order.find((k) => !d.steps[k]) ?? "finished";
  const [open, setOpen] = useState<string>(firstOpen === "installed" ? "service" : firstOpen);
  useEffect(() => setOpen(firstOpen), [firstOpen]);
  const doneCount = order.filter((k) => d.steps[k]).length;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div className="bw-head">
        <div>
          <h1>Setup guide</h1>
          <p className="bw-sub">Follow the steps below to start taking bookings (6 steps, about 3 minutes).</p>
        </div>
        <span className="bw-badge blue">
          {doneCount} of {order.length} done
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 4, background: "var(--surface-2)", marginBottom: 14, overflow: "hidden" }}>
        <div style={{ width: `${(doneCount / order.length) * 100}%`, height: "100%", background: "var(--accent-grad)", transition: "width .3s" }} />
      </div>
      <Flash data={actionData} />

      <div className="bw-card">
        <Step n={1} id="installed" title="Bookwell is installed in your store" done open={open} setOpen={setOpen}>
          <p style={{ margin: 0 }}>Welcome! Here's what you can do with Bookwell:</p>
          <ul className="bw-help" style={{ margin: "8px 0 12px", paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
            <li>Take individual, group, rental, full-day and multi-day bookings</li>
            <li>Collect deposits or full payment through Shopify checkout</li>
            <li>Email, SMS and WhatsApp reminders, and Google Calendar / Zoom</li>
            <li>Never get double-booked, on any plan</li>
          </ul>
          <button type="button" className="bw-btn dark" onClick={() => setOpen("service")}>
            Get started
          </button>
        </Step>

        <Step n={2} id="service" title="Create your first service" done={d.steps.service} open={open} setOpen={setOpen}>
          {d.steps.service ? (
            <div className="bw-stack" style={{ gap: 8 }}>
              <span>
                You have {d.services.length} service{d.services.length === 1 ? "" : "s"}: {d.services.map((s) => s.name).join(", ")}.
              </span>
              <div className="bw-row">
                <Link className="bw-btn sm" to={link(`/app/services/${d.services[0].id}`)}>
                  Edit {d.services[0].name}
                </Link>
                <Link className="bw-btn sm" to={link("/app/services", { new: 1 })}>
                  Add another
                </Link>
              </div>
            </div>
          ) : (
            <CreateService />
          )}
        </Step>

        <Step n={3} id="availability" title="Set when you're available" done={d.steps.availability} open={open} setOpen={setOpen} locked={!d.steps.service}>
          <Availability d={d} />
        </Step>

        <Step n={4} id="widget" title="Add the booking calendar to your store" done={d.steps.widget} open={open} setOpen={setOpen} locked={!d.steps.service}>
          <Widget d={d} />
        </Step>

        <Step n={5} id="testBooking" title="Make a test booking yourself" done={d.steps.testBooking} open={open} setOpen={setOpen} locked={!d.steps.availability}>
          <p className="bw-help" style={{ fontSize: 13, marginTop: 0 }}>
            Book like a customer would to see the whole flow: the calendar, the form and the confirmation. No payment is taken for free services. It shows up under
            Bookings straight away.
          </p>
          <div className="bw-row">
            {d.links.firstServicePage && (
              <a className="bw-btn primary" href={d.links.firstServicePage} target="_blank" rel="noreferrer">
                Book now
              </a>
            )}
            <RecheckButton />
          </div>
          <p className="bw-help">If your store has a password page, enter the store password first.</p>
        </Step>

        <Step n={6} id="finished" title="Final step" done={d.steps.finished} open={open} setOpen={setOpen}>
          <div className="bw-stack" style={{ gap: 10 }}>
            <b>1. Set up notifications</b>
            <div className="bw-stack" style={{ gap: 4, paddingLeft: 4 }}>
              <StatusLine on={d.notifications.email} label="Email confirmations and reminders" />
              <StatusLine on={d.notifications.sms} label="Text (SMS) reminders" />
              <StatusLine on={d.notifications.whatsapp} label="WhatsApp reminders" />
              <Link to={link("/app/settings", { tab: "notifications" })} className="bw-link">
                Set up notifications →
              </Link>
            </div>
            <b>2. Choose a plan</b>
            <span className="bw-help" style={{ fontSize: 13 }}>
              Every feature is included on every plan, including Free. Plans only differ in monthly bookings.{" "}
              <Link to={link("/app/billing")} className="bw-link">
                Explore plans
              </Link>
            </span>
            <b>3. Finish</b>
            <Form method="post">
              <input type="hidden" name="intent" value={d.steps.finished ? "reopen" : "finish"} />
              <button className={`bw-btn ${d.steps.finished ? "" : "dark"}`}>{d.steps.finished ? "Show the setup guide again" : "Finish setup"}</button>
            </Form>
          </div>
        </Step>
      </div>

      {!d.steps.finished && (
        <Form method="post" style={{ textAlign: "center", marginTop: 12 }}>
          <input type="hidden" name="intent" value="dismiss" />
          <button className="bw-btn plain">Skip the setup guide</button>
        </Form>
      )}
    </div>
  );
}

function Step({
  n,
  id,
  title,
  done,
  open,
  setOpen,
  locked,
  children,
}: {
  n: number;
  id: string;
  title: string;
  done?: boolean;
  open: string;
  setOpen: (id: string) => void;
  locked?: boolean;
  children: React.ReactNode;
}) {
  const isOpen = open === id;
  return (
    <div className="bw-step" data-open={isOpen || undefined}>
      <button type="button" className="bw-step-h" onClick={() => setOpen(isOpen ? "" : id)} aria-expanded={isOpen}>
        <span className={`bw-step-n${done ? " done" : ""}`}>{done ? "✓" : n}</span>
        <span className="bw-step-t">{title}</span>
        <span className="bw-step-c">{isOpen ? "▾" : "▸"}</span>
      </button>
      {isOpen && (
        <div className="bw-step-b">
          {locked && !done ? <div className="bw-alert warn" style={{ margin: "0 0 10px" }}>Complete the step before this one first.</div> : null}
          <div style={locked && !done ? { opacity: 0.5, pointerEvents: "none" } : undefined}>{children}</div>
        </div>
      )}
    </div>
  );
}

function StatusLine({ on, label }: { on: boolean; label: string }) {
  return (
    <span style={{ fontSize: 13 }}>
      <span className={`bw-badge ${on ? "green" : ""}`} style={{ marginRight: 8 }}>
        {on ? "On" : "Off"}
      </span>
      {label}
    </span>
  );
}

function RecheckButton() {
  const r = useRevalidator();
  return (
    <button type="button" className="bw-btn" onClick={() => r.revalidate()} disabled={r.state !== "idle"}>
      {r.state !== "idle" ? "Checking…" : "Check again"}
    </button>
  );
}

function CreateService() {
  const busy = useBusy();
  const shopify = useAppBridge();
  const options = BASIC_KEYS.map((k) => PRESETS.find((p) => p.key === k)!).filter(Boolean);
  const [preset, setPreset] = useState(options[0].key);
  const [product, setProduct] = useState<{ id: string; title: string } | null>(null);
  const chosen = options.find((p) => p.key === preset)!;
  const dayBased = chosen.values.type === "fullday" || chosen.values.type === "multiday";

  async function pick() {
    const sel = await shopify.resourcePicker({ type: "product", multiple: false });
    if (sel?.[0]) setProduct({ id: sel[0].id, title: sel[0].title });
  }

  return (
    <Form method="post" className="bw-stack" key={preset}>
      <input type="hidden" name="intent" value="createService" />
      <input type="hidden" name="preset" value={preset} />
      <input type="hidden" name="productId" value={product?.id ?? ""} />
      <span className="bw-label">What kind of bookings do you take?</span>
      <div className="bw-stack" style={{ gap: 8 }}>
        {options.map((p) => (
          <label key={p.key} className="bw-check-row">
            <input type="radio" name="presetPick" checked={preset === p.key} onChange={() => setPreset(p.key)} />
            <div>
              <div className="t">
                {p.icon} {p.title}
              </div>
              <div className="s">{p.blurb}</div>
            </div>
          </label>
        ))}
      </div>
      <div className="bw-grid">
        <div className="bw-field">
          <label>Service name</label>
          <input name="name" className="bw-input" defaultValue={chosen.values.name} required />
        </div>
        {!dayBased && (
          <div className="bw-field">
            <label>Duration (minutes)</label>
            <input name="duration" type="number" min={5} className="bw-input" defaultValue={chosen.values.durationMinutes ?? 60} />
          </div>
        )}
        <div className="bw-field">
          <label>Price{chosen.values.type === "multiday" ? " per day" : ""}</label>
          <input name="price" type="number" min={0} step="0.01" className="bw-input" defaultValue={chosen.values.price ?? 0} />
        </div>
      </div>
      <div className="bw-row">
        <button type="button" className="bw-btn sm" onClick={pick}>
          {product ? "Change product" : "Link to a product (optional)"}
        </button>
        <span className="bw-help">
          {product ? `The calendar will show on: ${product.title}` : "Shoppers book on this product's page. Without one, they book on your booking page."}
        </span>
      </div>
      <div>
        <button className="bw-btn dark" disabled={busy}>
          {busy ? "Creating…" : "Create service & continue"}
        </button>
      </div>
      <span className="bw-help">You can change everything later, and add deposits, add-ons, questions and more on the service page.</span>
    </Form>
  );
}

function Availability({ d }: { d: Data }) {
  const busy = useBusy();
  const link = useAppLink();
  if (!d.firstService) return <span className="bw-help">Create a service first.</span>;
  const staffless = d.firstService.staffMode === "none";
  const member = d.staff.find((m) => m.active) ?? d.staff[0];

  return (
    <div className="bw-stack">
      {d.unbookable.length > 0 && (
        <div className="bw-alert warn" style={{ margin: 0 }}>
          {d.unbookable.map((u) => `${u.name}: ${u.reason.toLowerCase()}`).join(" · ")}
        </div>
      )}
      <Form method="post" className="bw-stack">
        <input type="hidden" name="intent" value="availability" />
        {staffless ? (
          <>
            <input type="hidden" name="serviceId" value={d.firstService.id} />
            <span className="bw-help" style={{ fontSize: 13 }}>
              Opening hours for <b>{d.firstService.name}</b> (store time, {d.timezone}).
            </span>
            <HoursEditor rules={d.serviceHours} />
          </>
        ) : (
          <>
            {member ? (
              <>
                <input type="hidden" name="staffId" value={member.id} />
                <span className="bw-help" style={{ fontSize: 13 }}>
                  Working hours for <b>{member.name}</b>
                  {!member.active ? " (inactive: saving activates them)" : ""}, store time ({d.timezone}).
                </span>
              </>
            ) : (
              <div className="bw-grid two">
                <div className="bw-field">
                  <label>Who performs the service? (it can be you)</label>
                  <input name="staffName" className="bw-input" placeholder="Your name" required />
                </div>
                <div className="bw-field">
                  <label>Their email (optional)</label>
                  <input name="staffEmail" type="email" className="bw-input" />
                </div>
              </div>
            )}
            <HoursEditor rules={member?.availability ?? []} />
          </>
        )}
        <div className="bw-row">
          <button className="bw-btn dark" disabled={busy}>
            {busy ? "Saving…" : "Save hours"}
          </button>
          <Link className="bw-link" to={link("/app/staff")}>
            Add more team members, breaks and time off →
          </Link>
        </div>
      </Form>
    </div>
  );
}

function Widget({ d }: { d: Data }) {
  const linked = d.services.some((s) => s.productId);
  const state = (v: boolean | null) => (v === null ? <span className="bw-badge">Can't check</span> : v ? <span className="bw-badge green">Added</span> : <span className="bw-badge">Not added</span>);
  return (
    <div className="bw-stack">
      <span className="bw-help" style={{ fontSize: 13 }}>
        Choose one or more ways for customers to book. {d.theme.themeName ? `Your live theme: ${d.theme.themeName}.` : ""}
      </span>

      <div className="bw-option">
        <div>
          <div className="bw-row" style={{ gap: 8 }}>
            <b>Calendar on the product page</b> {state(d.theme.block)}
          </div>
          <div className="bw-help">
            Adds the Bookwell block to your product template; it appears on products linked to a service.
            {!linked ? " Link a product to your service first (Services → Edit → Link to a product)." : ""}
          </div>
        </div>
        <a className="bw-btn primary" href={d.links.addBlock} target="_blank" rel="noreferrer">
          Add to product page
        </a>
      </div>

      <div className="bw-option">
        <div>
          <div className="bw-row" style={{ gap: 8 }}>
            <b>Floating “Book now” button</b> {state(d.theme.embed)}
          </div>
          <div className="bw-help">
            A button on every page of your store. Turn it on, then click Save in the theme editor.
            {d.firstService ? (
              <>
                {" "}
                To open a calendar straight away, paste this service ID in its settings: <span className="bw-code" style={{ padding: "1px 6px" }}>{d.firstService.id}</span>
              </>
            ) : null}
          </div>
        </div>
        <a className="bw-btn" href={d.links.embed} target="_blank" rel="noreferrer">
          Turn on button
        </a>
      </div>

      <div className="bw-option">
        <div>
          <b>Booking page</b>
          <div className="bw-help">Works right away, no theme changes. Add it to your store menu (Online Store → Navigation) or share the link.</div>
          <div className="bw-code" style={{ marginTop: 6 }}>
            {d.links.bookPage}
          </div>
        </div>
        <a className="bw-btn" href={d.links.bookPage} target="_blank" rel="noreferrer">
          Preview
        </a>
      </div>

      <div className="bw-row">
        <RecheckButton />
        <span className="bw-help">After saving in the theme editor, click “Check again”.</span>
      </div>
    </div>
  );
}
