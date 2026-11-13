import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { handleBlockIntent } from "../models/blocks.server";
import { BlocksEditor, Flash, Modal, useAppLink, useBusy, ServicesTabs } from "../components/ui";

const KINDS = [
  ["rental", "🚲", "Bike / ski / trailer rental", "Also works with tools, photo booths, fashion"],
  ["court", "📍", "Sports field rental", "Tennis, squash, padel, golf…"],
  ["table", "🍽️", "Restaurant reservation", "Tables or private dining areas"],
  ["vehicle", "🚗", "Boat / house / car rental", "For a day or several days"],
  ["custom", "⚙️", "Custom", "Anything else with limited stock"],
] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const resources = await prisma.resource.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "asc" },
    include: { services: { select: { id: true, name: true } }, blocks: { orderBy: { createdAt: "asc" } } },
  });
  return json({ resources });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const f = (k: string) => String(form.get(k) || "").trim();

  if (intent === "save") {
    const id = f("id");
    const name = f("name").slice(0, 120);
    if (!name) return json({ error: "Give the equipment a name." }, { status: 400 });
    const data = {
      name,
      customerLabel: f("customerLabel").slice(0, 120) || null,
      description: f("description").slice(0, 2000) || null,
      kind: KINDS.some(([k]) => k === f("kind")) ? f("kind") : "custom",
      quantity: Math.max(1, Math.min(100_000, Math.round(Number(f("quantity")) || 1))),
      bufferMinutes: form.get("useBuffer") === "on" ? Math.max(0, Math.min(1440, Math.round(Number(f("bufferMinutes")) || 0))) : 0,
      active: form.get("active") !== "off",
    };
    if (id) {
      const r = await prisma.resource.updateMany({ where: { id, shopId: shop.id }, data });
      if (!r.count) return json({ error: "Not found." }, { status: 404 });
      return json({ ok: "Equipment saved.", saved: id });
    }
    const created = await prisma.resource.create({ data: { ...data, shopId: shop.id } });
    return json({ ok: "Equipment added. Link it to a service on the service's page.", saved: created.id });
  }

  const id = f("id") || f("resourceId");
  const resource = await prisma.resource.findFirst({ where: { id, shopId: shop.id } });
  if (!resource) return json({ error: "Not found." }, { status: 404 });

  const block = await handleBlockIntent(shop.id, form, { resourceId: id });
  if (block) return json(block);

  if (intent === "delete") {
    const used = await prisma.booking.count({ where: { resourceId: id, status: { in: ["confirmed", "pending"] }, endsAt: { gt: new Date() } } });
    if (used) return json({ error: "This equipment has upcoming bookings. Deactivate it instead." }, { status: 400 });
    await prisma.resource.delete({ where: { id } });
    return json({ ok: "Equipment deleted.", saved: "" });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

type R = ReturnType<typeof useLoaderData<typeof loader>>["resources"][number];

export default function Equipment() {
  const { resources } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params, setParams] = useSearchParams();
  const link = useAppLink();
  const [editing, setEditing] = useState<R | "new" | null>(null);
  const selected = resources.find((r) => r.id === params.get("item"));

  useEffect(() => {
    if (actionData && "saved" in actionData) {
      setEditing(null);
      const next = new URLSearchParams(params);
      if (actionData.saved) next.set("item", String(actionData.saved));
      else next.delete("item");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  return (
    <div>
      <ServicesTabs />
      <div className="bw-head">
        <div>
          <h1>
            Equipment <span className="bw-count">{resources.length}</span>
          </h1>
          <p className="bw-sub">Bikes, courts, tables, boats, rooms: anything with limited stock shared between services.</p>
        </div>
        <button type="button" className="bw-btn dark" onClick={() => setEditing("new")}>
          + Add equipment
        </button>
      </div>
      <Flash data={actionData} />

      <div className="bw-card" style={{ marginBottom: 16 }}>
        {resources.length === 0 ? (
          <div className="bw-empty-big">
            <div className="t">No equipment yet</div>
            Add the items you rent out and how many you have. Bookings for any service using an item draw from the same stock.
          </div>
        ) : (
          resources.map((r) => (
            <div className="bw-list-item" key={r.id} style={{ background: r.id === selected?.id ? "var(--surface-2)" : undefined }}>
              <span className="bw-avatar" style={{ background: "var(--accent-soft)", fontSize: 18 }}>
                {KINDS.find(([k]) => k === r.kind)?.[1] ?? "⚙️"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="bw-row" style={{ gap: 6 }}>
                  <b>{r.name}</b>
                  <span className="bw-badge blue">{r.quantity} in stock</span>
                  {!r.active && <span className="bw-badge">Inactive</span>}
                </div>
                <div className="bw-help">
                  {r.services.length ? `Used by ${r.services.map((s) => s.name).join(", ")}` : "Not used by any service yet"}
                  {r.bufferMinutes ? ` · ${r.bufferMinutes} min buffer` : ""}
                </div>
              </div>
              <button type="button" className="bw-btn sm" onClick={() => setEditing(r)}>
                Edit
              </button>
              <Link className="bw-btn sm" to={link("/app/equipment", { item: r.id })} preventScrollReset>
                Blocked dates
              </Link>
            </div>
          ))
        )}
      </div>

      {selected && (
        <div className="bw-card bw-section">
          <h2>Blocked dates · {selected.name}</h2>
          <p className="bw-sub">Maintenance days or closures for this equipment only.</p>
          <BlocksEditor blocks={selected.blocks} scope={{ name: "resourceId", value: selected.id }} />
        </div>
      )}

      {editing && <EquipmentModal r={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EquipmentModal({ r, onClose }: { r: R | null; onClose: () => void }) {
  const busy = useBusy();
  const [kind, setKind] = useState(r?.kind ?? "rental");
  const [useBuffer, setUseBuffer] = useState(Boolean(r?.bufferMinutes));
  return (
    <Modal title={r ? r.name : "Equipment"} onClose={onClose} wide>
      <Form method="post" className="bw-stack">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="id" value={r?.id ?? ""} />
        <input type="hidden" name="kind" value={kind} />
        <span className="bw-label">What do you want to sell or rent?</span>
        <div className="bw-types" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))" }}>
          {KINDS.map(([k, icon, title, hint]) => (
            <button type="button" key={k} className={`bw-type${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>
              <div className="ic">{icon}</div>
              <div className="t">{title}</div>
              <div className="s">{hint}</div>
            </button>
          ))}
        </div>
        <div className="bw-grid two">
          <div className="bw-field">
            <label>Internal name</label>
            <input name="name" className="bw-input" defaultValue={r?.name} placeholder="e.g. Mountain bike" required />
          </div>
          <div className="bw-field">
            <label>Customer label</label>
            <input name="customerLabel" className="bw-input" defaultValue={r?.customerLabel ?? ""} placeholder="Shown to customers" />
          </div>
        </div>
        <div className="bw-field">
          <label>Description</label>
          <textarea name="description" className="bw-textarea" defaultValue={r?.description ?? ""} placeholder="e.g. High-quality mountain bike suitable for all terrains." />
        </div>
        <div className="bw-grid two">
          <div className="bw-field">
            <label>Number of items</label>
            <input name="quantity" type="number" min={1} className="bw-input" defaultValue={r?.quantity ?? 1} />
            <span className="bw-help">How many can be booked at the same time.</span>
          </div>
          <div className="bw-field">
            <label className="bw-check-row" style={{ alignItems: "center" }}>
              <input type="checkbox" name="useBuffer" checked={useBuffer} onChange={(e) => setUseBuffer(e.target.checked)} /> Use buffer time
            </label>
            <input name="bufferMinutes" type="number" min={0} className="bw-input" defaultValue={r?.bufferMinutes ?? 30} disabled={!useBuffer} />
            <span className="bw-help">Minutes after each booking (cleaning, charging, turnover).</span>
          </div>
        </div>
        <label className="bw-check-row">
          <input type="hidden" name="active" value={r?.active === false ? "off" : "on"} />
          <span className="bw-help">Link this equipment to a service from the service's edit page.</span>
        </label>
        <div className="bw-row" style={{ justifyContent: "space-between" }}>
          <div />
          <div className="bw-row">
            <button type="button" className="bw-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="bw-btn primary" disabled={busy}>
              Save
            </button>
          </div>
        </div>
      </Form>
      {r && (
        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm(`Delete ${r.name}?`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="id" value={r.id} />
          <button className="bw-btn sm danger">Delete equipment</button>
        </Form>
      )}
    </Modal>
  );
}
