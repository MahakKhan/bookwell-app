import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { logAccess } from "../models/accessLog.server";
import { formatBookingWhen } from "../models/lifecycle.server";
import { EMAIL_RE } from "../models/submit.server";
import { Flash, Modal, STATUS_BADGE, STATUS_LABEL, initials, money, useAppLink, useBusy } from "../components/ui";

// Customers are created automatically from bookings (one per email), and can
// also be added by hand. Older bookings made before this page existed are
// linked on first visit.
async function backfill(shopId: string) {
  const orphans = await prisma.booking.findMany({
    where: { shopId, customerId: null },
    select: { id: true, customerName: true, customerEmail: true, customerPhone: true },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  for (const b of orphans) {
    const email = b.customerEmail.trim().toLowerCase();
    const c = await prisma.customer.upsert({
      where: { shopId_email: { shopId, email } },
      update: {},
      create: { shopId, email, name: b.customerName, phone: b.customerPhone },
    });
    await prisma.booking.update({ where: { id: b.id }, data: { customerId: c.id } });
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const url = new URL(request.url);
  const p = (k: string) => url.searchParams.get(k) || "";

  if (p("list") === "1") {
    const customers = await prisma.customer.findMany({
      where: { shopId: shop.id },
      select: { name: true, email: true, phone: true },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    await logAccess(shop.id, session, "customers.list", customers.length);
    return json({ mode: "list" as const, customers });
  }

  if (p("customer")) {
    const bookings = await prisma.booking.findMany({
      where: { shopId: shop.id, customerId: p("customer") },
      include: { service: { select: { name: true, type: true } } },
      orderBy: { startsAt: "desc" },
      take: 50,
    });
    await logAccess(shop.id, session, "customers.history", bookings.length, p("customer"));
    return json({
      mode: "history" as const,
      bookings: bookings.map((b) => ({
        id: b.id,
        when: formatBookingWhen(shop, b, b.service),
        service: b.service.name,
        status: b.status,
        total: Number(b.totalPrice),
      })),
    });
  }

  await backfill(shop.id);

  const q = p("q").trim();
  const where: Prisma.CustomerWhereInput = {
    shopId: shop.id,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { tags: { has: q } },
          ],
        }
      : {}),
  };
  const page = Math.max(1, Number(p("page")) || 1);
  const exporting = p("export") === "1";
  const take = exporting ? 10_000 : 50;
  const [customers, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { updatedAt: "desc" }, take, skip: exporting ? 0 : (page - 1) * take }),
    prisma.customer.count({ where }),
  ]);
  const stats = customers.length
    ? await prisma.booking.groupBy({
        by: ["customerId"],
        where: { shopId: shop.id, customerId: { in: customers.map((c) => c.id) }, status: { in: ["confirmed", "completed", "no_show"] } },
        _count: { _all: true },
        _sum: { totalPrice: true },
        _max: { startsAt: true },
      })
    : [];
  const byId = new Map(stats.map((s) => [s.customerId, s]));

  await logAccess(shop.id, session, exporting ? "customers.export" : "customers.view", customers.length, q ? "search" : undefined);

  return json({
    mode: "page" as const,
    currency: shop.currency,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / take)),
    customers: customers.map((c) => {
      const s = byId.get(c.id);
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone ?? "",
        notes: c.notes ?? "",
        tags: c.tags,
        bookings: s?._count._all ?? 0,
        spent: Number(s?._sum.totalPrice ?? 0),
        last: s?._max.startsAt ? new Date(s._max.startsAt).toISOString().slice(0, 10) : "",
        createdAt: c.createdAt.toISOString().slice(0, 10),
      };
    }),
  });
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
    const email = f("email").toLowerCase().slice(0, 200);
    if (!name || !EMAIL_RE.test(email)) return json({ error: "A name and a valid email are required." }, { status: 400 });
    const data = {
      name,
      email,
      phone: f("phone").slice(0, 40) || null,
      notes: f("notes").slice(0, 2000) || null,
      tags: f("tags").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 20),
    };
    try {
      if (id) {
        const updated = await prisma.customer.updateMany({ where: { id, shopId: shop.id }, data });
        if (!updated.count) return json({ error: "Customer not found." }, { status: 404 });
      } else {
        await prisma.customer.create({ data: { ...data, shopId: shop.id } });
      }
    } catch (e: any) {
      if (e?.code === "P2002") return json({ error: "A customer with that email already exists." }, { status: 400 });
      throw e;
    }
    return json({ ok: id ? "Customer saved." : "Customer added.", saved: true });
  }

  if (intent === "delete") {
    await prisma.customer.deleteMany({ where: { id: f("id"), shopId: shop.id } });
    return json({ ok: "Customer deleted. Their past bookings are kept.", saved: true });
  }

  return json({ error: "Unknown action." }, { status: 400 });
}

type C = { id: string; name: string; email: string; phone: string; notes: string; tags: string[]; bookings: number; spent: number; last: string; createdAt: string };

export default function Customers() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params, setParams] = useSearchParams();
  const link = useAppLink();
  const [editing, setEditing] = useState<C | "new" | null>(null);
  const exporter = useFetcher<typeof loader>();

  useEffect(() => {
    if (actionData && "saved" in actionData) setEditing(null);
  }, [actionData]);
  useEffect(() => {
    if (exporter.state === "idle" && exporter.data && exporter.data.mode === "page") downloadCsv(exporter.data.customers);
  }, [exporter.state, exporter.data]);

  if (data.mode !== "page") return null;

  return (
    <div>
      <div className="bw-head">
        <h1>
          Customers <span className="bw-count">{data.total}</span>
        </h1>
        <div className="bw-row">
          <button
            type="button"
            className="bw-btn"
            disabled={exporter.state !== "idle"}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("export", "1");
              exporter.load(`/app/customers?${next.toString()}`);
            }}
          >
            Export CSV
          </button>
          <button type="button" className="bw-btn dark" onClick={() => setEditing("new")}>
            + Add customer
          </button>
        </div>
      </div>
      <Flash data={actionData} />

      <div className="bw-card">
        <div className="bw-toolbar">
          <input
            className="bw-input grow"
            placeholder="Filter by customer name, email, phone or tag"
            defaultValue={params.get("q") ?? ""}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const next = new URLSearchParams(params);
              const v = (e.target as HTMLInputElement).value;
              if (v) next.set("q", v);
              else next.delete("q");
              next.delete("page");
              setParams(next);
            }}
          />
        </div>
        {data.customers.length === 0 ? (
          <div className="bw-empty-big">
            <div className="t">No customers yet</div>
            Customers are added automatically when someone books, or you can add them by hand.
          </div>
        ) : (
          <div className="bw-table-wrap">
            <table className="bw-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Tags</th>
                  <th>Bookings</th>
                  <th>Total booked</th>
                  <th>Last booking</th>
                </tr>
              </thead>
              <tbody>
                {data.customers.map((c) => (
                  <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => setEditing(c)}>
                    <td>
                      <div className="bw-row" style={{ gap: 10, flexWrap: "nowrap" }}>
                        <span className="bw-avatar" style={{ background: "var(--accent-grad)" }}>
                          {initials(c.name)}
                        </span>
                        <div>
                          <b>{c.name}</b>
                          <div className="muted">{c.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>{c.phone || <span className="muted">—</span>}</td>
                    <td>
                      <div className="bw-row" style={{ gap: 4 }}>
                        {c.tags.map((t) => (
                          <span key={t} className="bw-badge">
                            {t}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{c.bookings}</td>
                    <td>{money(c.spent, data.currency)}</td>
                    <td>{c.last || <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.pages > 1 && (
          <div className="bw-row" style={{ padding: 12, justifyContent: "center" }}>
            {data.page > 1 && (
              <Link className="bw-btn sm" to={link("/app/customers", { ...Object.fromEntries(params), page: data.page - 1 })}>
                ← Previous
              </Link>
            )}
            <span className="bw-help">
              Page {data.page} of {data.pages}
            </span>
            {data.page < data.pages && (
              <Link className="bw-btn sm" to={link("/app/customers", { ...Object.fromEntries(params), page: data.page + 1 })}>
                Next →
              </Link>
            )}
          </div>
        )}
      </div>

      {editing && <CustomerModal customer={editing === "new" ? null : editing} onClose={() => setEditing(null)} currency={data.currency} />}
    </div>
  );
}

function CustomerModal({ customer, onClose, currency }: { customer: C | null; onClose: () => void; currency: string }) {
  const busy = useBusy();
  const history = useFetcher<{ mode: "history"; bookings: { id: string; when: string; service: string; status: string; total: number }[] }>();
  useEffect(() => {
    if (customer) history.load(`/app/customers?customer=${customer.id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id]);

  return (
    <Modal title={customer ? customer.name : "Add customer"} onClose={onClose} wide={Boolean(customer)}>
      <Form method="post" className="bw-stack">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="id" value={customer?.id ?? ""} />
        <div className="bw-grid two">
          <div className="bw-field">
            <label>Name</label>
            <input name="name" className="bw-input" defaultValue={customer?.name} placeholder="John Doe" required />
          </div>
          <div className="bw-field">
            <label>Email address</label>
            <input name="email" type="email" className="bw-input" defaultValue={customer?.email} placeholder="john.doe@company.com" required />
          </div>
          <div className="bw-field">
            <label>Phone number (optional)</label>
            <input name="phone" className="bw-input" defaultValue={customer?.phone} placeholder="+1234567890" />
          </div>
          <div className="bw-field">
            <label>Tags (comma separated)</label>
            <input name="tags" className="bw-input" defaultValue={customer?.tags.join(", ")} placeholder="vip, regular" />
          </div>
        </div>
        <div className="bw-field">
          <label>Notes</label>
          <textarea name="notes" className="bw-textarea" defaultValue={customer?.notes} />
        </div>
        <div className="bw-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="bw-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="bw-btn primary" disabled={busy}>
            {customer ? "Save" : "Add customer"}
          </button>
        </div>
      </Form>
      {customer && (
        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm(`Delete ${customer.name}? Their bookings are kept.`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="id" value={customer.id} />
          <button type="submit" className="bw-btn sm danger">
            Delete customer
          </button>
        </Form>
      )}
      {customer && (
        <div className="bw-stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <span className="bw-label">
            Booking history · {customer.bookings} booking(s) · {money(customer.spent, currency)}
          </span>
          {history.state !== "idle" && !history.data ? (
            <div className="bw-help">Loading…</div>
          ) : history.data?.bookings.length ? (
            <div className="bw-mini-list">
              {history.data.bookings.map((b) => (
                <div className="it" key={b.id}>
                  <span>
                    <b>{b.when}</b> · {b.service}
                  </span>
                  <span className={`bw-badge ${STATUS_BADGE[b.status] ?? ""}`}>{STATUS_LABEL[b.status] ?? b.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="bw-dashed">No bookings yet</div>
          )}
        </div>
      )}
    </Modal>
  );
}

function downloadCsv(rows: C[]) {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Name", "Email", "Phone", "Tags", "Bookings", "Total booked", "Last booking", "Notes", "Created"];
  const lines = rows.map((c) => [c.name, c.email, c.phone, c.tags.join("; "), c.bookings, c.spent, c.last, c.notes, c.createdAt].map(esc).join(","));
  const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bookwell-customers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
