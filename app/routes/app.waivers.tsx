import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useFetcher, useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { formatInTz } from "../models/time.server";
import { Flash, Modal, useBusy, ServicesTabs } from "../components/ui";

const SAMPLE = `I understand that participating in this service involves risks. I confirm that I am in good health and have told the staff about any medical conditions, allergies or injuries.

I release the business, its owners and staff from liability for any injury or loss, except where caused by their negligence.

I have read this waiver, understand it, and sign it voluntarily.`;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const url = new URL(request.url);

  // Single signature (for the viewer / print).
  const sigId = url.searchParams.get("signature");
  if (sigId) {
    const s = await prisma.waiverSignature.findFirst({
      where: { id: sigId, booking: { shopId: shop.id } },
      include: { waiver: { select: { title: true } }, booking: { include: { service: { select: { name: true } } } } },
    });
    if (!s) return json({ mode: "signature" as const, signature: null });
    return json({
      mode: "signature" as const,
      signature: {
        id: s.id,
        title: s.waiver.title,
        text: s.waiverText,
        name: s.signerName,
        image: s.signature,
        signedAt: formatInTz(s.signedAt, shop.timezone, { dateStyle: "long", timeStyle: "short" }),
        ip: s.ip,
        userAgent: s.userAgent,
        customer: `${s.booking.customerName} · ${s.booking.customerEmail}`,
        booking: `${s.booking.service.name}, ${formatInTz(s.booking.startsAt, shop.timezone, { dateStyle: "medium", timeStyle: "short" })}`,
      },
    });
  }

  const [waivers, services, signatures] = await Promise.all([
    prisma.waiver.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "asc" }, include: { services: { select: { id: true, name: true } }, _count: { select: { signatures: true } } } }),
    prisma.service.findMany({ where: { shopId: shop.id, archived: false }, select: { id: true, name: true, waiverId: true }, orderBy: { createdAt: "asc" } }),
    prisma.waiverSignature.findMany({
      where: { booking: { shopId: shop.id } },
      orderBy: { signedAt: "desc" },
      take: 100,
      select: { id: true, signerName: true, signedAt: true, waiver: { select: { title: true } }, booking: { select: { customerEmail: true, startsAt: true, service: { select: { name: true } } } } },
    }),
  ]);
  return json({
    mode: "page" as const,
    waivers,
    services,
    signatures: signatures.map((s) => ({
      id: s.id,
      name: s.signerName,
      email: s.booking.customerEmail,
      waiver: s.waiver.title,
      service: s.booking.service.name,
      signedAt: formatInTz(s.signedAt, shop.timezone, { dateStyle: "medium", timeStyle: "short" }),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const f = (k: string) => String(form.get(k) || "").trim();

  if (intent === "save") {
    const title = f("title").slice(0, 150);
    const body = f("body").slice(0, 20_000);
    if (!title || body.length < 20) return json({ error: "Give the waiver a title and its full text." }, { status: 400 });
    const serviceIds = form.getAll("serviceIds").map(String);
    const data = { title, body, active: form.get("active") === "on" };
    const waiver = f("id")
      ? await prisma.waiver.update({ where: { id: (await prisma.waiver.findFirstOrThrow({ where: { id: f("id"), shopId: shop.id } })).id }, data })
      : await prisma.waiver.create({ data: { ...data, shopId: shop.id } });
    await prisma.$transaction([
      prisma.service.updateMany({ where: { shopId: shop.id, waiverId: waiver.id, id: { notIn: serviceIds } }, data: { waiverId: null } }),
      prisma.service.updateMany({ where: { shopId: shop.id, id: { in: serviceIds } }, data: { waiverId: waiver.id } }),
    ]);
    return json({ ok: f("id") ? "Waiver saved." : "Waiver created.", done: true });
  }
  if (intent === "delete") {
    const w = await prisma.waiver.findFirst({ where: { id: f("id"), shopId: shop.id }, include: { _count: { select: { signatures: true } } } });
    if (!w) return json({ error: "Not found." }, { status: 404 });
    if (w._count.signatures) {
      await prisma.waiver.update({ where: { id: w.id }, data: { active: false } });
      await prisma.service.updateMany({ where: { waiverId: w.id }, data: { waiverId: null } });
      return json({ ok: true, warning: "This waiver has signatures, so it was switched off instead of deleted to keep the records.", done: true });
    }
    await prisma.waiver.delete({ where: { id: w.id } });
    return json({ ok: "Waiver deleted.", done: true });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

type PageData = Extract<ReturnType<typeof useLoaderData<typeof loader>>, { mode: "page" }>;
type W = PageData["waivers"][number];

export default function Waivers() {
  const data = useLoaderData<typeof loader>() as PageData;
  const actionData = useActionData<typeof action>();
  const [editing, setEditing] = useState<W | "new" | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  useEffect(() => {
    if (actionData && "done" in actionData) setEditing(null);
  }, [actionData]);

  return (
    <div>
      <ServicesTabs />
      <div className="bw-head">
        <div>
          <h1>Waivers</h1>
          <p className="bw-sub">Customers read and sign before they can book. Every signature is stored with the booking.</p>
        </div>
        <button type="button" className="bw-btn dark" onClick={() => setEditing("new")}>
          + New waiver
        </button>
      </div>
      <Flash data={actionData} />

      <div className="bw-card" style={{ marginBottom: 16 }}>
        {data.waivers.length === 0 ? (
          <div className="bw-empty-big">
            <div className="t">No waivers yet</div>
            Create a liability waiver, consent form or terms customers must sign for a service.
          </div>
        ) : (
          data.waivers.map((w) => (
            <div key={w.id} className="bw-list-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="bw-row" style={{ gap: 6 }}>
                  <b>{w.title}</b>
                  {!w.active && <span className="bw-badge">Off</span>}
                  <span className="bw-badge blue">{w._count.signatures} signed</span>
                </div>
                <div className="bw-help">{w.services.length ? `Required for: ${w.services.map((s) => s.name).join(", ")}` : "Not used by any service yet"}</div>
              </div>
              <button type="button" className="bw-btn sm" onClick={() => setEditing(w)}>
                Edit
              </button>
            </div>
          ))
        )}
      </div>

      <div className="bw-card">
        <div className="bw-section" style={{ paddingBottom: 8 }}>
          <h2>Signed waivers</h2>
        </div>
        {data.signatures.length === 0 ? (
          <div className="bw-empty">No signatures yet.</div>
        ) : (
          <div className="bw-table-wrap">
            <table className="bw-table">
              <thead>
                <tr>
                  <th>Signed by</th>
                  <th>Waiver</th>
                  <th>Service</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.signatures.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.name}
                      <div className="muted">{s.email}</div>
                    </td>
                    <td>{s.waiver}</td>
                    <td>{s.service}</td>
                    <td className="muted">{s.signedAt}</td>
                    <td>
                      <button type="button" className="bw-btn sm" onClick={() => setViewing(s.id)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <WaiverModal w={editing === "new" ? null : editing} services={data.services} onClose={() => setEditing(null)} />}
      {viewing && <SignatureModal id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function WaiverModal({ w, services, onClose }: { w: W | null; services: PageData["services"]; onClose: () => void }) {
  const busy = useBusy();
  return (
    <Modal title={w ? w.title : "New waiver"} onClose={onClose} wide>
      <Form method="post" className="bw-stack">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="id" value={w?.id ?? ""} />
        <div className="bw-field">
          <label>Title</label>
          <input name="title" className="bw-input" defaultValue={w?.title ?? "Liability waiver"} required />
        </div>
        <div className="bw-field">
          <label>Waiver text</label>
          <textarea name="body" className="bw-textarea" style={{ minHeight: 220 }} defaultValue={w?.body ?? SAMPLE} required />
          <span className="bw-help">This is a starting template, not legal advice. Have it checked for your business and country.</span>
        </div>
        <div className="bw-field">
          <label>Required for these services</label>
          <div className="bw-row">
            {services.map((s) => (
              <label key={s.id} className="bw-check-row" style={{ marginRight: 12 }}>
                <input type="checkbox" name="serviceIds" value={s.id} defaultChecked={w ? s.waiverId === w.id : false} /> {s.name}
                {s.waiverId && s.waiverId !== w?.id ? <span className="bw-help"> (replaces its current waiver)</span> : null}
              </label>
            ))}
          </div>
        </div>
        <label className="bw-check-row">
          <input type="checkbox" name="active" defaultChecked={w?.active ?? true} /> Active
        </label>
        <div className="bw-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="bw-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="bw-btn primary" disabled={busy}>
            Save
          </button>
        </div>
      </Form>
      {w && (
        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm(`Delete “${w.title}”?`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="id" value={w.id} />
          <button className="bw-btn sm danger">Delete waiver</button>
        </Form>
      )}
    </Modal>
  );
}

function SignatureModal({ id, onClose }: { id: string; onClose: () => void }) {
  const f = useFetcher<typeof loader>();
  useEffect(() => {
    f.load(`/app/waivers?signature=${encodeURIComponent(id)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const s = f.data && f.data.mode === "signature" ? f.data.signature : null;

  const print = () => {
    if (!s) return;
    const w = window.open("", "_blank");
    if (!w) return;
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    w.document.write(
      `<html><head><title>${esc(s.title)} – ${esc(s.name)}</title></head><body style="font-family:system-ui;max-width:700px;margin:40px auto;line-height:1.5">` +
        `<h1>${esc(s.title)}</h1><div style="white-space:pre-wrap">${esc(s.text)}</div><hr>` +
        `<p><b>Signed by:</b> ${esc(s.name)}<br><b>Customer:</b> ${esc(s.customer)}<br><b>Booking:</b> ${esc(s.booking)}<br><b>Signed:</b> ${esc(s.signedAt)}<br><b>IP:</b> ${esc(s.ip ?? "—")}</p>` +
        `<img src="${s.image}" style="max-width:420px;border:1px solid #ccc"></body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <Modal title={s ? s.title : "Signed waiver"} onClose={onClose} wide>
      {!s ? (
        <div className="bw-help">{f.state !== "idle" ? "Loading…" : "Not found."}</div>
      ) : (
        <div className="bw-stack">
          <dl className="bw-kv">
            <dt>Signed by</dt>
            <dd>{s.name}</dd>
            <dt>Customer</dt>
            <dd>{s.customer}</dd>
            <dt>Booking</dt>
            <dd>{s.booking}</dd>
            <dt>Signed</dt>
            <dd>{s.signedAt}</dd>
            <dt>IP address</dt>
            <dd>{s.ip ?? "—"}</dd>
          </dl>
          <img src={s.image} alt={`Signature of ${s.name}`} style={{ maxWidth: 420, border: "1px solid var(--border)", borderRadius: 8 }} />
          <details>
            <summary className="bw-link" style={{ cursor: "pointer" }}>
              Text that was signed
            </summary>
            <div className="bw-code" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
              {s.text}
            </div>
          </details>
          <div>
            <button type="button" className="bw-btn" onClick={print}>
              Print / save as PDF
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
