import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { handleBlockIntent, parseHours } from "../models/blocks.server";
import { EMAIL_RE } from "../models/submit.server";
import { seatsAllowed } from "../plans";
import { BlocksEditor, Flash, HoursEditor, Modal, initials, useAppLink, useBusy } from "../components/ui";

const appUrl = () => (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");
const COLORS = ["#5b5bd6", "#0f9d8a", "#d97706", "#db2777", "#2563eb", "#7c3aed", "#059669", "#dc2626"];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const [staff, services] = await Promise.all([
    prisma.staffMember.findMany({
      where: { shopId: shop.id },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: { availability: true, blocks: { orderBy: { createdAt: "asc" } }, _count: { select: { bookings: true } } },
    }),
    prisma.service.findMany({ where: { shopId: shop.id, archived: false, staffMode: "staff" }, select: { id: true, name: true, staffIds: true } }),
  ]);
  return json({
    planName: shop.planName,
    timezone: shop.timezone,
    atLimit: staff.filter((m) => m.active).length >= seatsAllowed(shop.planName),
    seats: seatsAllowed(shop.planName),
    portalBase: `${appUrl()}/portal/`,
    staff: staff.map((m) => ({
      ...m,
      bookings: m._count.bookings,
      services: services.filter((s) => s.staffIds.length === 0 || s.staffIds.includes(m.id)).map((s) => s.name),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const f = (k: string) => String(form.get(k) || "").trim();
  const perms = () => ({
    portalAccess: form.get("portalAccess") === "on",
    canEditAvailability: form.get("canEditAvailability") === "on",
    hidePrices: form.get("hidePrices") === "on",
    hideContact: form.get("hideContact") === "on",
    canCreateBookings: form.get("canCreateBookings") === "on",
    canBookAnyService: form.get("canBookAnyService") === "on",
  });

  if (intent === "create") {
    const name = [f("firstName"), f("lastName")].filter(Boolean).join(" ").slice(0, 120);
    const email = f("email").toLowerCase();
    if (!name) return json({ error: "A name is required." }, { status: 400 });
    if (email && !EMAIL_RE.test(email)) return json({ error: "That email doesn't look valid." }, { status: 400 });
    const activeCount = await prisma.staffMember.count({ where: { shopId: shop.id, active: true } });
    if (activeCount >= seatsAllowed(shop.planName)) {
      return json({ error: `Your plan includes ${seatsAllowed(shop.planName)} team member(s). Add a seat or upgrade on the Billing page.` }, { status: 403 });
    }
    const count = await prisma.staffMember.count({ where: { shopId: shop.id } });
    const staff = await prisma.staffMember.create({
      data: { shopId: shop.id, name, email: email || null, color: COLORS[count % COLORS.length], position: count, ...perms() },
    });
    await prisma.availabilityRule.createMany({
      data: [1, 2, 3, 4, 5].map((weekday) => ({ staffId: staff.id, weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
    });
    return json({ ok: `${name} added with Mon–Fri 9–5 hours. Adjust them below.`, created: staff.id });
  }

  const id = f("id") || f("staffId");
  const staff = await prisma.staffMember.findFirst({ where: { id, shopId: shop.id } });
  if (!staff) return json({ error: "Team member not found." }, { status: 404 });

  const block = await handleBlockIntent(shop.id, form, { staffId: staff.id });
  if (block) return json(block);

  if (intent === "details") {
    const name = f("name").slice(0, 120);
    const email = f("email").toLowerCase();
    if (!name) return json({ error: "A name is required." }, { status: 400 });
    if (email && !EMAIL_RE.test(email)) return json({ error: "That email doesn't look valid." }, { status: 400 });
    await prisma.staffMember.update({
      where: { id },
      data: {
        name,
        email: email || null,
        phone: f("phone").slice(0, 40) || null,
        bio: f("bio").slice(0, 500) || null,
        color: /^#[0-9a-fA-F]{6}$/.test(f("color")) ? f("color") : staff.color,
        ...perms(),
      },
    });
    return json({ ok: "Saved." });
  }
  if (intent === "hours") {
    try {
      const rules = parseHours(form);
      await prisma.$transaction([
        prisma.availabilityRule.deleteMany({ where: { staffId: id } }),
        prisma.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, staffId: id })) }),
      ]);
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 400 });
    }
    return json({ ok: "Working hours saved." });
  }
  if (intent === "toggle") {
    if (!staff.active) {
      const activeCount = await prisma.staffMember.count({ where: { shopId: shop.id, active: true } });
      if (activeCount >= seatsAllowed(shop.planName)) {
        return json({ error: "All your team seats are in use. Add a seat on the Billing page first." }, { status: 403 });
      }
    }
    await prisma.staffMember.update({ where: { id }, data: { active: !staff.active } });
    return json({ ok: staff.active ? `${staff.name} is now inactive and can't be booked.` : `${staff.name} is active again.` });
  }
  if (intent === "rotatePortal") {
    await prisma.staffMember.update({ where: { id }, data: { portalToken: crypto.randomUUID().replace(/-/g, "") } });
    return json({ ok: "New portal link created. The old link no longer works." });
  }
  if (intent === "delete") {
    const bookings = await prisma.booking.count({ where: { staffId: id } });
    if (bookings > 0) {
      await prisma.staffMember.update({ where: { id }, data: { active: false } });
      return json({ ok: true, warning: "This team member has bookings, so they were deactivated instead of deleted to keep history." });
    }
    await prisma.staffMember.delete({ where: { id } });
    return json({ ok: "Team member removed.", deleted: true });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

type Member = ReturnType<typeof useLoaderData<typeof loader>>["staff"][number];

export default function Team() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params, setParams] = useSearchParams();
  const link = useAppLink();
  const [adding, setAdding] = useState(false);
  const selectedId = params.get("member") ?? data.staff[0]?.id;
  const selected = data.staff.find((m) => m.id === selectedId);

  useEffect(() => {
    if (actionData && "created" in actionData) {
      setAdding(false);
      const next = new URLSearchParams(params);
      next.set("member", String(actionData.created));
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return (
    <div>
      <div className="bw-head">
        <h1>
          Team members <span className="bw-count">{data.staff.length}</span>
        </h1>
        <button type="button" className="bw-btn dark" onClick={() => setAdding(true)} disabled={data.atLimit}>
          + Add a teammate
        </button>
      </div>
      {data.atLimit && (
        <div className="bw-alert info">
          All {data.seats} team seat(s) on your plan are in use. <Link to={link("/app/billing")}>Add a seat or upgrade</Link> to add more.
        </div>
      )}
      <Flash data={actionData} />

      <div className="bw-card" style={{ marginBottom: 16 }}>
        {data.staff.length === 0 ? (
          <div className="bw-empty-big">
            <div className="t">No team members yet</div>
            Add the people who perform your services. Each has their own hours and time off.
          </div>
        ) : (
          data.staff.map((m) => (
            <div key={m.id} className="bw-list-item" style={{ background: m.id === selectedId ? "var(--surface-2)" : undefined }}>
              <span className="bw-avatar" style={{ background: m.color }}>
                {initials(m.name)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="bw-row" style={{ gap: 6 }}>
                  <b>{m.name}</b>
                  {!m.active && <span className="bw-badge">Inactive</span>}
                  {m.portalAccess && <span className="bw-badge blue">Portal</span>}
                </div>
                <div className="bw-help">
                  {m.email || "No email"} · {m.services.length ? m.services.join(", ") : "No services"}
                </div>
              </div>
              <Link className="bw-btn sm" to={link("/app/staff", { member: m.id })} preventScrollReset>
                Edit
              </Link>
            </div>
          ))
        )}
      </div>

      {selected && <MemberEditor key={selected.id} m={selected} timezone={data.timezone} portalBase={data.portalBase} />}

      {adding && (
        <Modal title="Add a new team member" onClose={() => setAdding(false)}>
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="create" />
            <div className="bw-grid two">
              <div className="bw-field">
                <label>First name</label>
                <input name="firstName" className="bw-input" placeholder="John" required />
              </div>
              <div className="bw-field">
                <label>Last name</label>
                <input name="lastName" className="bw-input" placeholder="Doe" />
              </div>
            </div>
            <div className="bw-field">
              <label>Email address</label>
              <input name="email" type="email" className="bw-input" placeholder="john.doe@company.com" />
            </div>
            <PortalPermissions />
            <div className="bw-row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="bw-btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button className="bw-btn primary">Create</button>
            </div>
          </Form>
        </Modal>
      )}
    </div>
  );
}

function PortalPermissions({ m }: { m?: Partial<Member> }) {
  const [access, setAccess] = useState(Boolean(m?.portalAccess));
  const row = (name: string, label: string, checked?: boolean) => (
    <label className="bw-check-row" style={{ opacity: access ? 1 : 0.5 }}>
      <input type="checkbox" name={name} defaultChecked={checked} disabled={!access} /> {label}
    </label>
  );
  return (
    <div className="bw-stack" style={{ gap: 8 }}>
      <span className="bw-label">Team portal permissions</span>
      <label className="bw-check-row">
        <input type="checkbox" name="portalAccess" checked={access} onChange={(e) => setAccess(e.target.checked)} />
        <div>
          <div className="t">Can open the team portal and see their bookings</div>
          <div className="s">A private link, no Shopify account needed.</div>
        </div>
      </label>
      {row("canEditAvailability", "Can change their own working hours", m?.canEditAvailability)}
      {row("hidePrices", "Hide booking prices in the portal", m?.hidePrices)}
      {row("hideContact", "Hide customer contact details in the portal", m?.hideContact)}
      {row("canCreateBookings", "Can create manual bookings (their own services)", m?.canCreateBookings)}
      {row("canBookAnyService", "Can create manual bookings on any service", m?.canBookAnyService)}
    </div>
  );
}

function MemberEditor({ m, timezone, portalBase }: { m: Member; timezone: string; portalBase: string }) {
  const busy = useBusy();
  const portalUrl = `${portalBase}${m.portalToken}`;
  return (
    <div className="bw-card">
      <div className="bw-section">
        <div className="bw-row between">
          <h2>{m.name}</h2>
          <div className="bw-row">
            <Form method="post">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="id" value={m.id} />
              <button className="bw-btn sm">{m.active ? "Deactivate" : "Activate"}</button>
            </Form>
            <Form
              method="post"
              onSubmit={(e) => {
                if (!confirm(`Remove ${m.name}?`)) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="id" value={m.id} />
              <button className="bw-btn sm danger">Delete</button>
            </Form>
          </div>
        </div>
        <Form method="post" className="bw-stack" style={{ marginTop: 12 }}>
          <input type="hidden" name="intent" value="details" />
          <input type="hidden" name="id" value={m.id} />
          <div className="bw-grid two">
            <div className="bw-field">
              <label>Name</label>
              <input name="name" className="bw-input" defaultValue={m.name} required />
            </div>
            <div className="bw-field">
              <label>Email</label>
              <input name="email" type="email" className="bw-input" defaultValue={m.email ?? ""} />
            </div>
            <div className="bw-field">
              <label>Phone</label>
              <input name="phone" className="bw-input" defaultValue={m.phone ?? ""} />
            </div>
            <div className="bw-field">
              <label>Calendar colour</label>
              <input type="color" name="color" defaultValue={m.color} style={{ width: 60, height: 36, border: "none", background: "none" }} />
            </div>
          </div>
          <div className="bw-field">
            <label>Short bio (shown in the booking widget)</label>
            <textarea name="bio" className="bw-textarea" style={{ minHeight: 60 }} defaultValue={m.bio ?? ""} />
          </div>
          <PortalPermissions m={m} />
          {m.portalAccess && (
            <div className="bw-field">
              <label>Portal link (send this to {m.name})</label>
              <div className="bw-row">
                <span className="bw-code" style={{ flex: 1 }}>
                  {portalUrl}
                </span>
                <button type="button" className="bw-btn sm" onClick={() => navigator.clipboard?.writeText(portalUrl)}>
                  Copy
                </button>
              </div>
            </div>
          )}
          <div>
            <button className="bw-btn primary" disabled={busy}>
              Save details
            </button>
          </div>
        </Form>
        {m.portalAccess && (
          <Form method="post" style={{ marginTop: 8 }}>
            <input type="hidden" name="intent" value="rotatePortal" />
            <input type="hidden" name="id" value={m.id} />
            <button className="bw-btn sm plain">Create a new portal link (revokes the old one)</button>
          </Form>
        )}
      </div>

      <div className="bw-section">
        <h2>Working hours</h2>
        <p className="bw-sub">Store time ({timezone}). Customers can only book inside these hours.</p>
        <Form method="post" className="bw-stack">
          <input type="hidden" name="intent" value="hours" />
          <input type="hidden" name="id" value={m.id} />
          <HoursEditor rules={m.availability} />
          <div>
            <button className="bw-btn primary" disabled={busy}>
              Save hours
            </button>
          </div>
        </Form>
      </div>

      <div className="bw-section">
        <h2>Time off &amp; breaks</h2>
        <p className="bw-sub">Holidays, sick days or a daily lunch break for {m.name} only.</p>
        <BlocksEditor blocks={m.blocks} scope={{ name: "staffId", value: m.id }} />
      </div>
    </div>
  );
}
