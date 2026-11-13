import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { unbookableServices } from "../models/booking.server";
import { linkProductToService, unlinkProduct } from "../models/metafield.server";
import { handleBlockIntent, parseHours } from "../models/blocks.server";
import { bookPageUrl } from "../models/lifecycle.server";
import { PRESETS, TYPE_LABEL } from "../presets";
import { BlocksEditor, Flash, HoursEditor, QuestionRow, useAppLink, useBusy, type Question } from "../components/ui";

const TYPES = [
  ["appointment", "Appointment", "One customer per slot"],
  ["group", "Group / class", "Shared slot with capacity"],
  ["virtual", "Virtual", "Online meeting link"],
  ["event", "Event / tickets", "Fixed times, limited seats"],
  ["rental", "Hourly rental", "Courts, rooms, tables"],
  ["fullday", "Full day", "Whole days, no times"],
  ["multiday", "Multi-day", "Start and end date"],
] as const;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const id = params.id!;

  const [staff, resources] = await Promise.all([
    prisma.staffMember.findMany({ where: { shopId: shop.id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, active: true } }),
    prisma.resource.findMany({ where: { shopId: shop.id, active: true }, select: { id: true, name: true, quantity: true } }),
  ]);

  if (id === "new") {
    const preset = PRESETS.find((p) => p.key === new URL(request.url).searchParams.get("preset")) ?? PRESETS[0];
    const v = preset.values;
    const dayBased = v.type === "fullday" || v.type === "multiday";
    return json({
      problem: null as string | null,
      isNew: true,
      currency: shop.currency,
      staff,
      resources,
      bookUrl: null as string | null,
      service: {
        id: "new",
        name: v.name ?? "",
        description: "",
        type: v.type ?? "appointment",
        color: "#5b5bd6",
        durationMinutes: v.durationMinutes ?? 60,
        price: v.price ?? 0,
        bufferMinutes: v.bufferMinutes ?? 0,
        capacity: v.capacity ?? 1,
        maxQuantity: v.maxQuantity ?? 1,
        slotStepMinutes: v.slotStepMinutes ?? null,
        minNoticeMinutes: 0,
        maxAdvanceDays: 60,
        dailyLimit: null as number | null,
        minDays: v.minDays ?? 1,
        maxDays: v.maxDays ?? 14,
        staffMode: v.staffMode ?? "staff",
        staffIds: [] as string[],
        resourceId: null as string | null,
        paymentMode: v.paymentMode ?? "none",
        depositValue: v.depositValue ?? 0,
        meetingUrl: "",
        allowRecurring: v.allowRecurring ?? false,
        maxRecurrences: v.maxRecurrences ?? 8,
        allowMultiSlot: false,
        maxSlots: 5,
        autoMeet: false,
        autoZoom: false,
        autoTeams: false,
        waitlistEnabled: true,
        productId: null as string | null,
        active: true,
      },
      addons: [] as { id?: string; name: string; price: number; durationMinutes: number }[],
      questions: [] as { id?: string; label: string; type: string; options: string; required: boolean }[],
      hours: [1, 2, 3, 4, 5, ...(dayBased ? [6, 0] : [])].map((weekday) => ({ weekday, startMinute: dayBased ? 0 : 540, endMinute: dayBased ? 1440 : 1020 })),
      blocks: [],
    });
  }

  const service = await prisma.service.findFirst({
    where: { id, shopId: shop.id },
    include: {
      addons: { orderBy: { position: "asc" } },
      questions: { orderBy: { position: "asc" } },
      availability: true,
      blocks: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!service) throw new Response("Not found", { status: 404 });
  const problem = (await unbookableServices(shop.id)).find((u) => u.id === service.id)?.reason ?? null;

  return json({
    problem,
    isNew: false,
    currency: shop.currency,
    staff,
    resources,
    bookUrl: bookPageUrl(shop.shopDomain, service.id) as string | null,
    service: {
      ...service,
      price: Number(service.price),
      depositValue: Number(service.depositValue),
      description: service.description ?? "",
      meetingUrl: service.meetingUrl ?? "",
    },
    addons: service.addons.map((a) => ({ id: a.id, name: a.name, price: Number(a.price), durationMinutes: a.durationMinutes })),
    questions: service.questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options.join(", "), required: q.required })),
    hours: service.availability,
    blocks: service.blocks,
  });
}

const int = (v: FormDataEntryValue | null, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && String(v ?? "") !== "" ? Math.min(max, Math.max(min, n)) : def;
};
const dec = (v: FormDataEntryValue | null, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && String(v ?? "") !== "" ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : def;
};

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin, redirect } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");
  const id = params.id!;

  if (intent !== "save") {
    if (id === "new") return json({ error: "Save the service first." }, { status: 400 });
    const owned = await prisma.service.findFirst({ where: { id, shopId: shop.id }, select: { id: true } });
    if (!owned) return json({ error: "Not found" }, { status: 404 });
    const r = await handleBlockIntent(shop.id, form, { serviceId: id });
    return json(r ?? { error: "Unknown action." });
  }

  const existing = id === "new" ? null : await prisma.service.findFirst({ where: { id, shopId: shop.id } });
  if (id !== "new" && !existing) return json({ error: "Not found" }, { status: 404 });
  const name = String(form.get("name") || "").trim().slice(0, 120);
  if (!name) return json({ error: "Give the service a name." }, { status: 400 });
  const type = TYPES.some(([t]) => t === form.get("type")) ? String(form.get("type")) : "appointment";
  const dayBased = type === "fullday" || type === "multiday";
  const staffMode = dayBased || form.get("staffMode") === "none" ? "none" : "staff";
  const paymentMode = ["none", "full", "deposit_percent", "deposit_fixed"].includes(String(form.get("paymentMode"))) ? String(form.get("paymentMode")) : "none";
  const productId = String(form.get("productId") || "") || null;
  if (productId && !/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) return json({ error: "Invalid product." }, { status: 400 });
  const resourceId = String(form.get("resourceId") || "") || null;
  if (resourceId && !(await prisma.resource.findFirst({ where: { id: resourceId, shopId: shop.id } }))) {
    return json({ error: "Unknown equipment." }, { status: 400 });
  }
  const staffIds = form.getAll("staffIds").map(String);
  const meetingUrl = String(form.get("meetingUrl") || "").trim();
  if (meetingUrl && !/^https:\/\//i.test(meetingUrl)) return json({ error: "The meeting link must start with https://" }, { status: 400 });

  let hours: ReturnType<typeof parseHours> = [];
  if (staffMode === "none") {
    try {
      hours = parseHours(form);
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 400 });
    }
    if (!hours.length) return json({ error: "Open at least one day so customers can book." }, { status: 400 });
  }

  let addons: { id?: string; name: string; price: number; durationMinutes: number }[] = [];
  let questions: { id?: string; label: string; type: string; options: string; required: boolean }[] = [];
  try {
    addons = JSON.parse(String(form.get("addons") || "[]"));
    questions = JSON.parse(String(form.get("questions") || "[]"));
  } catch {
    return json({ error: "Invalid add-ons or questions." }, { status: 400 });
  }

  const data = {
    name,
    type,
    description: String(form.get("description") || "").trim().slice(0, 2000) || null,
    color: /^#[0-9a-fA-F]{6}$/.test(String(form.get("color"))) ? String(form.get("color")) : "#5b5bd6",
    durationMinutes: dayBased ? 1440 : int(form.get("durationMinutes"), 60, 5, 1440),
    price: dec(form.get("price"), 0, 0, 1_000_000),
    bufferMinutes: int(form.get("bufferMinutes"), 0, 0, 480),
    capacity: int(form.get("capacity"), 1, 1, 10_000),
    maxQuantity: int(form.get("maxQuantity"), 1, 1, 10_000),
    slotStepMinutes: String(form.get("slotStepMinutes") || "") ? int(form.get("slotStepMinutes"), 30, 5, 1440) : null,
    minNoticeMinutes: Math.round(dec(form.get("minNoticeHours"), 0, 0, 24 * 90) * 60),
    maxAdvanceDays: int(form.get("maxAdvanceDays"), 60, 1, 730),
    dailyLimit: String(form.get("dailyLimit") || "") ? int(form.get("dailyLimit"), 1, 1, 10_000) : null,
    minDays: int(form.get("minDays"), 1, 1, 365),
    maxDays: int(form.get("maxDays"), 14, 1, 365),
    staffMode,
    staffIds: staffMode === "staff" ? staffIds : [],
    resourceId,
    paymentMode,
    depositValue: dec(form.get("depositValue"), 0, 0, 1_000_000),
    meetingUrl: meetingUrl || null,
    allowRecurring: form.get("allowRecurring") === "on",
    maxRecurrences: int(form.get("maxRecurrences"), 8, 2, 52),
    waitlistEnabled: form.get("waitlistEnabled") === "on",
    allowMultiSlot: form.get("allowMultiSlot") === "on",
    maxSlots: int(form.get("maxSlots"), 5, 2, 50),
    autoMeet: form.get("meetingSource") === "google",
    autoZoom: form.get("meetingSource") === "zoom",
    autoTeams: form.get("meetingSource") === "teams",
    productId,
  };
  if (data.maxDays < data.minDays) data.maxDays = data.minDays;
  if (data.maxQuantity > data.capacity && !resourceId) data.maxQuantity = data.capacity;
  if (paymentMode === "deposit_percent" && data.depositValue > 100) data.depositValue = 100;

  const service = existing
    ? await prisma.service.update({ where: { id: existing.id }, data })
    : await prisma.service.create({ data: { ...data, shopId: shop.id } });

  // Hours, add-ons and questions are independent: write them in parallel
  // (each query is a round trip to the remote database).
  const keepAddons = addons.filter((a) => a.id).map((a) => a.id!);
  const keepQ = questions.filter((q) => q.id).map((q) => q.id!);
  await Promise.all([
    prisma.$transaction([
      prisma.availabilityRule.deleteMany({ where: { serviceId: service.id } }),
      prisma.availabilityRule.createMany({ data: hours.map((h) => ({ ...h, serviceId: service.id })) }),
    ]),
    (async () => {
      await prisma.serviceAddon.deleteMany({ where: { serviceId: service.id, id: { notIn: keepAddons } } });
      await Promise.all(
        addons.map((a, i) => {
          const row = {
            name: String(a.name || "").trim().slice(0, 120) || "Add-on",
            price: Math.max(0, Number(a.price) || 0),
            durationMinutes: Math.max(0, Math.min(480, Math.round(Number(a.durationMinutes) || 0))),
            position: i,
          };
          return a.id
            ? prisma.serviceAddon.updateMany({ where: { id: a.id, serviceId: service.id }, data: row })
            : prisma.serviceAddon.create({ data: { ...row, serviceId: service.id } });
        }),
      );
    })(),
    (async () => {
      await prisma.bookingQuestion.deleteMany({ where: { serviceId: service.id, id: { notIn: keepQ } } });
      await Promise.all(
        questions.map((q, i) => {
          const qtype = ["text", "textarea", "select", "checkbox"].includes(q.type) ? q.type : "text";
          const row = {
            label: String(q.label || "").trim().slice(0, 200) || "Question",
            type: qtype,
            options: qtype === "select" ? String(q.options || "").split(",").map((o) => o.trim()).filter(Boolean).slice(0, 30) : [],
            required: Boolean(q.required),
            position: i,
          };
          return q.id
            ? prisma.bookingQuestion.updateMany({ where: { id: q.id, serviceId: service.id }, data: row })
            : prisma.bookingQuestion.create({ data: { ...row, shopId: shop.id, serviceId: service.id } });
        }),
      );
    })(),
  ]);

  // Product link.
  let warning: string | undefined;
  if (existing?.productId && existing.productId !== productId) await unlinkProduct(admin, existing.productId).catch(() => {});
  if (productId && productId !== existing?.productId) {
    try {
      await linkProductToService(admin, productId, service.id);
    } catch (e) {
      warning = `Saved, but linking the product failed: ${(e as Error).message}`;
    }
  }

  if (!existing) return redirect(`/app/services/${service.id}?saved=1`);
  return json({ ok: "Service saved.", warning });
}

type Addon = { id?: string; name: string; price: number; durationMinutes: number };

export default function ServiceEdit() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const link = useAppLink();
  const busy = useBusy();
  const shopify = useAppBridge();
  const s = data.service;

  const [type, setType] = useState(s.type);
  const [staffMode, setStaffMode] = useState(s.staffMode);
  const [paymentMode, setPaymentMode] = useState(s.paymentMode);
  const [product, setProduct] = useState<{ id: string; title: string } | null>(s.productId ? { id: s.productId, title: "Linked product" } : null);
  const [addons, setAddons] = useState<Addon[]>(data.addons);
  const [questions, setQuestions] = useState<Question[]>(data.questions);
  const dayBased = type === "fullday" || type === "multiday";
  const effectiveStaffMode = dayBased ? "none" : staffMode;
  const saved = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("saved") === "1";
  const fromAi = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("ai") === "1";

  async function pickProduct() {
    const selected = await shopify.resourcePicker({ type: "product", multiple: false });
    const first = selected?.[0];
    if (first) setProduct({ id: first.id, title: first.title });
  }

  return (
    <div>
      <div className="bw-head">
        <div className="bw-row" style={{ gap: 12 }}>
          <Link to={link("/app/services")} className="bw-back" aria-label="Back to services">
            &larr;
          </Link>
          <h1>{data.isNew ? "New service" : s.name}</h1>
          {!data.isNew && <span className="bw-badge blue">{TYPE_LABEL[s.type]}</span>}
        </div>
        {data.bookUrl && (
          <a className="bw-btn" href={data.bookUrl} target="_blank" rel="noreferrer">
            Preview booking page
          </a>
        )}
      </div>
      {saved && !actionData && <div className="bw-alert ok">Service created. Link it to a product or share its booking page.</div>}
      {fromAi && !actionData && (
        <div className="bw-alert info">
          AI drafted this service. It's paused until you check the details, save, and switch it on from My services.
        </div>
      )}
      <Flash data={actionData} />
      {data.problem && (
        <div className="bw-alert err">
          Customers can't book this service: {data.problem.toLowerCase()}.{" "}
          {data.problem.includes("team") ? <Link to={link("/app/staff")}>Go to Team</Link> : "Set its opening hours below."}
        </div>
      )}

      <Form method="post" className="bw-card">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="productId" value={product?.id ?? ""} />
        <input type="hidden" name="addons" value={JSON.stringify(addons)} />
        <input type="hidden" name="questions" value={JSON.stringify(questions)} />

        <div className="bw-section">
          <h2>What do you want to sell?</h2>
          <p className="bw-sub">The booking type decides how customers pick a time.</p>
          <div className="bw-types" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {TYPES.map(([t, label, hint]) => (
              <button type="button" key={t} className={`bw-type${type === t ? " on" : ""}`} onClick={() => setType(t)}>
                <div className="t">{label}</div>
                <div className="s">{hint}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="bw-section">
          <h2>General information</h2>
          <div className="bw-stack" style={{ marginTop: 10 }}>
            <div className="bw-grid two">
              <div className="bw-field">
                <label>Name</label>
                <input name="name" className="bw-input" defaultValue={s.name} required maxLength={120} />
              </div>
              <div className="bw-field">
                <label>Calendar colour</label>
                <input type="color" name="color" defaultValue={s.color} style={{ width: 60, height: 36, border: "none", background: "none" }} />
              </div>
            </div>
            <div className="bw-field">
              <label>Description</label>
              <textarea name="description" className="bw-textarea" defaultValue={s.description} placeholder="Shown to customers on the booking page." />
            </div>
            <div className="bw-grid">
              {!dayBased && (
                <div className="bw-field">
                  <label>Duration (minutes)</label>
                  <input type="number" name="durationMinutes" className="bw-input" min={5} max={1440} defaultValue={s.durationMinutes} />
                </div>
              )}
              <div className="bw-field">
                <label>Price ({data.currency}){type === "multiday" ? " per day" : ""}</label>
                <input type="number" name="price" className="bw-input" min={0} step="0.01" defaultValue={s.price} />
              </div>
            </div>
            <div className="bw-row">
              <button type="button" className="bw-btn" onClick={pickProduct}>
                {product ? "Change product" : "Link to a product"}
              </button>
              {product && (
                <button type="button" className="bw-btn plain" onClick={() => setProduct(null)}>
                  Unlink
                </button>
              )}
              <span className="bw-help">
                {product
                  ? `The booking widget shows on: ${product.title}`
                  : "Optional. Without a product, customers book through your booking page."}
              </span>
            </div>
          </div>
        </div>

        <div className="bw-section">
          <h2>Who provides it</h2>
          {dayBased ? (
            <p className="bw-sub">Day-based bookings don't need a team member; set the open days below.</p>
          ) : (
            <div className="bw-stack" style={{ marginTop: 10 }}>
              <label className="bw-check-row">
                <input type="radio" name="staffMode" value="staff" checked={staffMode === "staff"} onChange={() => setStaffMode("staff")} />
                <div>
                  <div className="t">Team members</div>
                  <div className="s">Uses each team member's working hours. Customers can pick who they want.</div>
                </div>
              </label>
              <label className="bw-check-row">
                <input type="radio" name="staffMode" value="none" checked={staffMode === "none"} onChange={() => setStaffMode("none")} />
                <div>
                  <div className="t">No team member</div>
                  <div className="s">The service has its own opening hours (rentals, events, tables).</div>
                </div>
              </label>
            </div>
          )}
          {effectiveStaffMode === "staff" && (
            <div className="bw-stack" style={{ marginTop: 12 }}>
              <span className="bw-label">Who can perform it (none selected = everyone)</span>
              {data.staff.length === 0 ? (
                <div className="bw-alert warn" style={{ margin: 0 }}>
                  You have no team members yet. <Link to={link("/app/staff")}>Add one</Link> or choose "No team member".
                </div>
              ) : (
                <div className="bw-row">
                  {data.staff.map((m) => (
                    <label key={m.id} className="bw-check-row" style={{ marginRight: 12 }}>
                      <input type="checkbox" name="staffIds" value={m.id} defaultChecked={s.staffIds.includes(m.id)} />
                      <span>
                        {m.name}
                        {!m.active ? " (inactive)" : ""}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {effectiveStaffMode === "none" && (
            <div className="bw-stack" style={{ marginTop: 12 }}>
              <span className="bw-label">{dayBased ? "Open days" : "Opening hours"} (store time)</span>
              <HoursEditor rules={data.hours} defaultStart={dayBased ? 0 : 540} defaultEnd={dayBased ? 1440 : 1020} />
            </div>
          )}
        </div>

        <div className="bw-section">
          <h2>Quantity and capacity</h2>
          <div className="bw-grid" style={{ marginTop: 10 }}>
            <div className="bw-field">
              <label>Spots per {dayBased ? "day" : "time slot"}</label>
              <input type="number" name="capacity" className="bw-input" min={1} defaultValue={s.capacity} />
              <span className="bw-help">1 = private. More = group, class, tables or units in stock.</span>
            </div>
            <div className="bw-field">
              <label>Max spots per booking</label>
              <input type="number" name="maxQuantity" className="bw-input" min={1} defaultValue={s.maxQuantity} />
              <span className="bw-help">How many one customer can take (e.g. tickets, people).</span>
            </div>
            <div className="bw-field">
              <label>Equipment / resource</label>
              <select name="resourceId" className="bw-select" defaultValue={s.resourceId ?? ""}>
                <option value="">None</option>
                {data.resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.quantity} in stock)
                  </option>
                ))}
              </select>
              <span className="bw-help">Shared stock across services. <Link to={link("/app/equipment")}>Manage equipment</Link></span>
            </div>
            {type === "multiday" && (
              <>
                <div className="bw-field">
                  <label>Minimum days</label>
                  <input type="number" name="minDays" className="bw-input" min={1} defaultValue={s.minDays} />
                </div>
                <div className="bw-field">
                  <label>Maximum days</label>
                  <input type="number" name="maxDays" className="bw-input" min={1} defaultValue={s.maxDays} />
                </div>
              </>
            )}
          </div>
        </div>

        <div className="bw-section">
          <h2>Booking rules</h2>
          <div className="bw-grid" style={{ marginTop: 10 }}>
            {!dayBased && (
              <>
                <div className="bw-field">
                  <label>Start times every (minutes)</label>
                  <input type="number" name="slotStepMinutes" className="bw-input" min={5} placeholder="Same as duration" defaultValue={s.slotStepMinutes ?? ""} />
                </div>
                <div className="bw-field">
                  <label>Buffer after (minutes)</label>
                  <input type="number" name="bufferMinutes" className="bw-input" min={0} defaultValue={s.bufferMinutes} />
                </div>
              </>
            )}
            <div className="bw-field">
              <label>Minimum notice (hours)</label>
              <input type="number" name="minNoticeHours" className="bw-input" min={0} step="0.5" defaultValue={s.minNoticeMinutes / 60} />
            </div>
            <div className="bw-field">
              <label>Bookable up to (days ahead)</label>
              <input type="number" name="maxAdvanceDays" className="bw-input" min={1} defaultValue={s.maxAdvanceDays} />
            </div>
            <div className="bw-field">
              <label>Max bookings per day</label>
              <input type="number" name="dailyLimit" className="bw-input" min={1} placeholder="Unlimited" defaultValue={s.dailyLimit ?? ""} />
            </div>
          </div>
          <div className="bw-stack" style={{ marginTop: 14 }}>
            {!dayBased && (
              <label className="bw-check-row">
                <input type="checkbox" name="allowRecurring" defaultChecked={s.allowRecurring} />
                <div>
                  <div className="t">Allow recurring bookings</div>
                  <div className="s">Customers can book the same time weekly (or every 2 / 4 weeks) for several sessions.</div>
                  <div className="bw-row" style={{ marginTop: 6 }}>
                    <span className="bw-help">Up to</span>
                    <input type="number" name="maxRecurrences" className="bw-input auto" style={{ width: 80 }} min={2} max={52} defaultValue={s.maxRecurrences} />
                    <span className="bw-help">sessions</span>
                  </div>
                </div>
              </label>
            )}
            {!dayBased && (
              <label className="bw-check-row">
                <input type="checkbox" name="allowMultiSlot" defaultChecked={s.allowMultiSlot} />
                <div>
                  <div className="t">Bundle booking: several times in one go</div>
                  <div className="s">Customers pick several separate slots (any days) and pay once.</div>
                  <div className="bw-row" style={{ marginTop: 6 }}>
                    <span className="bw-help">Up to</span>
                    <input type="number" name="maxSlots" className="bw-input auto" style={{ width: 80 }} min={2} max={50} defaultValue={s.maxSlots} />
                    <span className="bw-help">slots</span>
                  </div>
                </div>
              </label>
            )}
            <label className="bw-check-row">
              <input type="checkbox" name="waitlistEnabled" defaultChecked={s.waitlistEnabled} />
              <div>
                <div className="t">Waitlist when full</div>
                <div className="s">Customers can join a waitlist and get an email when a spot frees up.</div>
              </div>
            </label>
          </div>
        </div>

        <div className="bw-section">
          <h2>Payment</h2>
          <p className="bw-sub">Prepayments and deposits go through Shopify checkout; the slot is held while the customer pays.</p>
          <div className="bw-grid two" style={{ marginTop: 10 }}>
            <div className="bw-field">
              <label>When does the customer pay?</label>
              <select name="paymentMode" className="bw-select" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
                <option value="none">Free / pay at the appointment</option>
                <option value="full">Full price up front</option>
                <option value="deposit_percent">Deposit: percentage</option>
                <option value="deposit_fixed">Deposit: fixed amount</option>
              </select>
            </div>
            {paymentMode.startsWith("deposit") && (
              <div className="bw-field">
                <label>{paymentMode === "deposit_percent" ? "Deposit (%)" : `Deposit (${data.currency})`}</label>
                <input type="number" name="depositValue" className="bw-input" min={0} step="0.01" defaultValue={s.depositValue} />
              </div>
            )}
          </div>
        </div>

        {type === "virtual" && (
          <div className="bw-section">
            <h2>Online meeting</h2>
            <div className="bw-field" style={{ marginTop: 10 }}>
              <label>Zoom / Google Meet / Teams link</label>
              <input name="meetingUrl" className="bw-input" placeholder="https://meet.google.com/abc-defg-hij" defaultValue={s.meetingUrl} />
              <span className="bw-help">Sent in the confirmation and reminder emails.</span>
            </div>
            <div className="bw-stack" style={{ marginTop: 12, gap: 8 }}>
              <span className="bw-label">Meeting link for each booking</span>
              <label className="bw-check-row">
                <input type="radio" name="meetingSource" value="fixed" defaultChecked={!s.autoMeet && !s.autoZoom && !s.autoTeams} /> Use the fixed link above
              </label>
              <label className="bw-check-row">
                <input type="radio" name="meetingSource" value="google" defaultChecked={s.autoMeet} />
                <div>
                  <div className="t">A new Google Meet for every booking</div>
                  <div className="s">Needs Google connected in Integrations.</div>
                </div>
              </label>
              <label className="bw-check-row">
                <input type="radio" name="meetingSource" value="zoom" defaultChecked={s.autoZoom} />
                <div>
                  <div className="t">A new Zoom meeting for every booking</div>
                  <div className="s">Needs Zoom connected in Integrations.</div>
                </div>
              </label>
              <label className="bw-check-row">
                <input type="radio" name="meetingSource" value="teams" defaultChecked={s.autoTeams} />
                <div>
                  <div className="t">A new Microsoft Teams meeting for every booking</div>
                  <div className="s">Needs Outlook (Microsoft 365) connected in Integrations.</div>
                </div>
              </label>
            </div>
          </div>
        )}
        {type !== "virtual" && <input type="hidden" name="meetingUrl" value={s.meetingUrl} />}

        <div className="bw-section">
          <div className="bw-row between">
            <div>
              <h2>Add-ons</h2>
              <p className="bw-sub">Optional extras customers can add (extra time, products, upgrades).</p>
            </div>
            <button type="button" className="bw-btn sm" onClick={() => setAddons([...addons, { name: "", price: 0, durationMinutes: 0 }])}>
              + Add-on
            </button>
          </div>
          {addons.length === 0 ? (
            <div className="bw-dashed" style={{ marginTop: 10 }}>No add-ons</div>
          ) : (
            <div className="bw-stack" style={{ marginTop: 10 }}>
              {addons.map((a, i) => (
                <div className="bw-row" key={a.id ?? `n${i}`}>
                  <input className="bw-input" style={{ flex: "2 1 180px" }} placeholder="Name" value={a.name} onChange={(e) => setAddons(addons.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <input className="bw-input" style={{ flex: "1 1 90px" }} type="number" min={0} step="0.01" placeholder="Price" value={a.price} onChange={(e) => setAddons(addons.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) } : x)))} />
                  {!dayBased && (
                    <input className="bw-input" style={{ flex: "1 1 90px" }} type="number" min={0} placeholder="+ minutes" value={a.durationMinutes} onChange={(e) => setAddons(addons.map((x, j) => (j === i ? { ...x, durationMinutes: Number(e.target.value) } : x)))} />
                  )}
                  <button type="button" className="bw-btn sm danger" onClick={() => setAddons(addons.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bw-section">
          <div className="bw-row between">
            <div>
              <h2>Booking questions</h2>
              <p className="bw-sub">Extra fields on this service's booking form. Questions for every service live in Settings.</p>
            </div>
            <button type="button" className="bw-btn sm" onClick={() => setQuestions([...questions, { label: "", type: "text", options: "", required: false }])}>
              + Question
            </button>
          </div>
          {questions.length === 0 ? (
            <div className="bw-dashed" style={{ marginTop: 10 }}>No questions</div>
          ) : (
            <div className="bw-stack" style={{ marginTop: 10 }}>
              {questions.map((q, i) => (
                <QuestionRow key={q.id ?? `n${i}`} q={q} onChange={(nq) => setQuestions(questions.map((x, j) => (j === i ? nq : x)))} onRemove={() => setQuestions(questions.filter((_, j) => j !== i))} />
              ))}
            </div>
          )}
        </div>

        <div className="bw-sticky-save">
          <Link className="bw-btn" to={link("/app/services")}>
            Cancel
          </Link>
          <button type="submit" className="bw-btn primary" disabled={busy}>
            {busy ? "Saving…" : data.isNew ? "Create service" : "Save"}
          </button>
        </div>
      </Form>

      {!data.isNew && (
        <div className="bw-card bw-section" style={{ marginTop: 16 }}>
          <h2>Blocked dates for this service</h2>
          <p className="bw-sub">Applies only to this service. Store-wide closures live in Settings → Blocked times.</p>
          <BlocksEditor blocks={data.blocks} scope={{ name: "serviceId", value: s.id }} showBreaks={!dayBased} />
        </div>
      )}
    </div>
  );
}
