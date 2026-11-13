import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { grantPackage, syncPackages } from "../models/packages.server";
import { cancelContract, ensureSellingPlan, intervalLabel, productInfo, removeSellingPlan } from "../models/subscriptions.server";
import { EMAIL_RE } from "../models/submit.server";
import { Flash, Modal, money, useBusy, ServicesTabs } from "../components/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  void syncPackages(shop).catch(() => {});
  const [packages, sold, services] = await Promise.all([
    prisma.package.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "asc" }, include: { _count: { select: { sold: true } } } }),
    prisma.customerPackage.findMany({
      where: { shopId: shop.id, status: { not: "cancelled" } },
      include: { package: { select: { name: true, kind: true, credits: true } }, _count: { select: { bookings: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.service.findMany({ where: { shopId: shop.id, archived: false }, select: { id: true, name: true } }),
  ]);
  return json({
    currency: shop.currency,
    // Auto-renew needs Shopify's Subscription API access (approved per app).
    subscriptionsEnabled: (session.scope ?? "").includes("write_own_subscription_contracts"),
    buyPage: `https://${shop.shopDomain}/apps/booking/packages`,
    services,
    packages: await Promise.all(
      packages.map(async (p) => ({
        ...p,
        price: Number(p.price),
        soldCount: p._count.sold,
        renews: p.recurring ? intervalLabel(p.billingInterval, p.billingIntervalCount) : null,
        productTitle: p.productId ? ((await productInfo(shop.shopDomain, p.productId).catch(() => null))?.title ?? "Linked product") : null,
      })),
    ),
    sold: sold.map((c) => ({
      id: c.id,
      name: c.customerName,
      email: c.customerEmail,
      packageName: c.package.name,
      kind: c.package.kind,
      total: c.package.credits,
      left: c.creditsLeft,
      used: c._count.bookings,
      expiresAt: c.expiresAt?.toISOString().slice(0, 10) ?? null,
      status: c.status,
      source: c.source,
      subscription: Boolean(c.subscriptionContractId),
      renewsAt: c.nextBillingDate?.toISOString().slice(0, 10) ?? null,
      failures: c.billingFailures,
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
    const name = f("name").slice(0, 120);
    if (!name) return json({ error: "Give the package a name." }, { status: 400 });
    const kind = f("kind") === "membership" ? "membership" : "pack";
    const recurring = form.get("recurring") === "on";
    const productId = f("productId") || null;
    if (recurring && !productId) return json({ error: "Auto-renewing packages need a linked product (it's what customers subscribe to at checkout)." }, { status: 400 });
    if (productId && !/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) return json({ error: "Invalid product." }, { status: 400 });
    const data = {
      name,
      description: f("description").slice(0, 1000) || null,
      kind,
      recurring,
      productId: recurring ? productId : null,
      billingInterval: ["WEEK", "MONTH", "YEAR"].includes(f("billingInterval")) ? f("billingInterval") : "MONTH",
      billingIntervalCount: Math.max(1, Math.min(12, Math.round(Number(f("billingIntervalCount")) || 1))),
      credits: kind === "pack" ? Math.max(1, Math.min(1000, Math.round(Number(f("credits")) || 1))) : null,
      validityDays: Math.max(0, Math.min(3650, Math.round(Number(f("validityDays")) || 0))),
      price: Math.max(0, Math.round((Number(f("price")) || 0) * 100) / 100),
      serviceIds: form.getAll("serviceIds").map(String),
      active: form.get("active") === "on",
    };
    let pkg;
    const isNew = !f("id");
    if (f("id")) {
      const before = await prisma.package.findFirst({ where: { id: f("id"), shopId: shop.id } });
      if (!before) return json({ error: "Not found." }, { status: 404 });
      pkg = await prisma.package.update({ where: { id: before.id }, data });
      const planChanged =
        before.recurring !== pkg.recurring || before.productId !== pkg.productId || before.billingInterval !== pkg.billingInterval ||
        before.billingIntervalCount !== pkg.billingIntervalCount || before.name !== pkg.name;
      if (!planChanged && (pkg.sellingPlanId || !pkg.recurring)) return json({ ok: "Package saved.", done: true });
    } else {
      pkg = await prisma.package.create({ data: { ...data, shopId: shop.id } });
    }
    try {
      if (pkg.recurring) await ensureSellingPlan(shop, pkg);
      else await removeSellingPlan(shop, pkg);
    } catch (e) {
      return json({ ok: true, warning: `Saved, but the Shopify subscription plan couldn't be set up: ${(e as Error).message}`, done: true });
    }
    return json({
      ok: pkg.recurring
        ? "Saved. Customers can now subscribe from the packages page; the price comes from the linked product."
        : isNew
          ? "Package created."
          : "Package saved.",
      done: true,
    });
  }
  if (intent === "delete") {
    const target = await prisma.package.findFirst({ where: { id: f("id"), shopId: shop.id } });
    if (target) await removeSellingPlan(shop, target);
    const sold = await prisma.customerPackage.count({ where: { packageId: f("id"), status: "active" } });
    if (sold) {
      await prisma.package.updateMany({ where: { id: f("id"), shopId: shop.id }, data: { active: false } });
      return json({ ok: true, warning: "Customers still hold this package, so it was hidden from sale instead of deleted.", done: true });
    }
    await prisma.package.deleteMany({ where: { id: f("id"), shopId: shop.id } });
    return json({ ok: "Package deleted.", done: true });
  }
  if (intent === "grant") {
    const email = f("email").toLowerCase();
    if (!f("name") || !EMAIL_RE.test(email)) return json({ error: "Customer name and a valid email are required." }, { status: 400 });
    try {
      await grantPackage(shop, f("packageId"), { name: f("name"), email });
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 400 });
    }
    return json({ ok: "Package given to the customer.", done: true });
  }
  if (intent === "adjust") {
    const n = Math.round(Number(f("credits")));
    if (!Number.isFinite(n) || n < 0) return json({ error: "Enter a number of sessions." }, { status: 400 });
    await prisma.customerPackage.updateMany({ where: { id: f("id"), shopId: shop.id, creditsLeft: { not: null } }, data: { creditsLeft: n } });
    return json({ ok: "Sessions updated." });
  }
  if (intent === "cancelHolding") {
    const cp = await prisma.customerPackage.findFirst({ where: { id: f("id"), shopId: shop.id } });
    if (!cp) return json({ error: "Not found." }, { status: 404 });
    if (cp.subscriptionContractId) {
      try {
        await cancelContract(shop, cp);
      } catch (e) {
        return json({ error: `Shopify couldn't cancel the subscription: ${(e as Error).message}` }, { status: 400 });
      }
      return json({ ok: "Subscription cancelled. The customer keeps access until the end of the period they paid for." });
    }
    await prisma.customerPackage.update({ where: { id: cp.id }, data: { status: "cancelled" } });
    return json({ ok: "Package cancelled for that customer." });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

type P = ReturnType<typeof useLoaderData<typeof loader>>["packages"][number];

export default function Packages() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [editing, setEditing] = useState<P | "new" | null>(null);
  const [granting, setGranting] = useState(false);
  useEffect(() => {
    if (actionData && "done" in actionData) {
      setEditing(null);
      setGranting(false);
    }
  }, [actionData]);

  return (
    <div>
      <ServicesTabs />
      <div className="bw-head">
        <div>
          <h1>
            Packages &amp; memberships <span className="bw-count">{data.packages.length}</span>
          </h1>
          <p className="bw-sub">Sell class packs (e.g. 10 sessions) or memberships (unlimited for a month). Customers redeem them with their email when booking.</p>
        </div>
        <div className="bw-row">
          <a className="bw-btn" href={data.buyPage} target="_blank" rel="noreferrer">
            View buy page
          </a>
          <button type="button" className="bw-btn" disabled={!data.packages.length} onClick={() => setGranting(true)}>
            Give to a customer
          </button>
          <button type="button" className="bw-btn dark" onClick={() => setEditing("new")}>
            + New package
          </button>
        </div>
      </div>
      <Flash data={actionData} />

      <div className="bw-card" style={{ marginBottom: 16 }}>
        {data.packages.length === 0 ? (
          <div className="bw-empty-big">
            <div className="t">No packages yet</div>
            Create a 10-class pass, a monthly membership or a gift bundle.
          </div>
        ) : (
          data.packages.map((p) => (
            <div key={p.id} className="bw-list-item">
              <div style={{ flex: 1 }}>
                <div className="bw-row" style={{ gap: 6 }}>
                  <b>{p.name}</b>
                  <span className="bw-badge blue">{p.kind === "membership" ? "Membership · unlimited" : `${p.credits} sessions`}</span>
                  {p.renews && <span className="bw-badge green">Auto-renews {p.renews}</span>}
                  {p.recurring && !p.sellingPlanId && <span className="bw-badge red">Subscription plan not set up</span>}
                  {!p.active && <span className="bw-badge">Hidden</span>}
                </div>
                <div className="bw-help">
                  {money(p.price, data.currency)} · {p.recurring ? `product: ${p.productTitle}` : p.validityDays ? `valid ${p.validityDays} days` : "never expires"} ·{" "}
                  {p.serviceIds.length ? data.services.filter((s) => p.serviceIds.includes(s.id)).map((s) => s.name).join(", ") : "all services"} · sold {p.soldCount}
                </div>
              </div>
              <button className="bw-btn sm" onClick={() => setEditing(p)}>
                Edit
              </button>
            </div>
          ))
        )}
      </div>

      <div className="bw-card">
        <div className="bw-section" style={{ paddingBottom: 8 }}>
          <h2>Customers holding packages</h2>
        </div>
        {data.sold.length === 0 ? (
          <div className="bw-empty">None yet.</div>
        ) : (
          <div className="bw-table-wrap">
            <table className="bw-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Package</th>
                  <th>Sessions left</th>
                  <th>Used</th>
                  <th>Expires / renews</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.sold.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.name}
                      <div className="muted">{c.email}</div>
                    </td>
                    <td>{c.packageName}</td>
                    <td>
                      {c.left === null ? (
                        "Unlimited"
                      ) : (
                        <Form method="post" className="bw-row" style={{ gap: 4 }}>
                          <input type="hidden" name="intent" value="adjust" />
                          <input type="hidden" name="id" value={c.id} />
                          <input name="credits" type="number" min={0} defaultValue={c.left} className="bw-input auto" style={{ width: 70 }} />
                          <button className="bw-btn sm">Set</button>
                        </Form>
                      )}
                    </td>
                    <td>{c.used}</td>
                    <td>
                      {c.subscription && c.status === "active" ? `Renews ${c.renewsAt}` : (c.expiresAt ?? "—")}
                      {c.failures > 0 && <div className="muted">{c.failures} failed payment(s)</div>}
                    </td>
                    <td>
                      <span className={`bw-badge ${c.status === "active" ? "green" : c.status === "pending" || c.status === "past_due" ? "amber" : ""}`}>
                        {c.status === "pending" ? "Awaiting payment" : c.status === "past_due" ? "Payment failed" : c.status}
                      </span>
                      {c.subscription && <div className="muted">Subscription</div>}
                    </td>
                    <td>
                      {!["expired", "cancelled"].includes(c.status) && (
                        <Form
                          method="post"
                          onSubmit={(e) => {
                            if (!confirm(c.subscription ? "Cancel this subscription? The customer won't be charged again." : "Cancel this package for the customer?")) e.preventDefault();
                          }}
                        >
                          <input type="hidden" name="intent" value="cancelHolding" />
                          <input type="hidden" name="id" value={c.id} />
                          <button className="bw-btn sm danger">Cancel</button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <PackageModal p={editing === "new" ? null : editing} services={data.services} currency={data.currency} subscriptionsEnabled={data.subscriptionsEnabled} onClose={() => setEditing(null)} />}
      {granting && (
        <Modal title="Give a package to a customer" onClose={() => setGranting(false)}>
          <Form method="post" className="bw-stack">
            <input type="hidden" name="intent" value="grant" />
            <div className="bw-field">
              <label>Package</label>
              <select name="packageId" className="bw-select">
                {data.packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="bw-grid two">
              <div className="bw-field">
                <label>Customer name</label>
                <input name="name" className="bw-input" required />
              </div>
              <div className="bw-field">
                <label>Customer email</label>
                <input name="email" type="email" className="bw-input" required />
              </div>
            </div>
            <span className="bw-help">Use this when the customer paid in store or it's a gift. It's active straight away.</span>
            <div className="bw-row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="bw-btn" onClick={() => setGranting(false)}>
                Cancel
              </button>
              <button className="bw-btn primary">Give package</button>
            </div>
          </Form>
        </Modal>
      )}
    </div>
  );
}

function PackageModal({ p, services, currency, subscriptionsEnabled, onClose }: { p: P | null; services: { id: string; name: string }[]; currency: string; subscriptionsEnabled: boolean; onClose: () => void }) {
  const busy = useBusy();
  const shopify = useAppBridge();
  const [kind, setKind] = useState(p?.kind ?? "pack");
  const [recurring, setRecurring] = useState(Boolean(p?.recurring));
  const [product, setProduct] = useState<{ id: string; title: string } | null>(p?.productId ? { id: p.productId, title: p.productTitle ?? "Linked product" } : null);
  async function pickProduct() {
    const selected = await shopify.resourcePicker({ type: "product", multiple: false });
    const first = selected?.[0];
    if (first) setProduct({ id: first.id, title: first.title });
  }
  return (
    <Modal title={p ? p.name : "New package"} onClose={onClose}>
      <Form method="post" className="bw-stack">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="id" value={p?.id ?? ""} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="productId" value={recurring ? (product?.id ?? "") : ""} />
        <div className="bw-types" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button type="button" className={`bw-type${kind === "pack" ? " on" : ""}`} onClick={() => setKind("pack")}>
            <div className="t">Class pack</div>
            <div className="s">A number of sessions, e.g. 10 classes.</div>
          </button>
          <button type="button" className={`bw-type${kind === "membership" ? " on" : ""}`} onClick={() => setKind("membership")}>
            <div className="t">Membership</div>
            <div className="s">Unlimited bookings until it expires.</div>
          </button>
        </div>
        <div className="bw-field">
          <label>Name</label>
          <input name="name" className="bw-input" defaultValue={p?.name} placeholder={kind === "pack" ? "10-class pass" : "Monthly membership"} required />
        </div>
        <div className="bw-field">
          <label>Description</label>
          <textarea name="description" className="bw-textarea" defaultValue={p?.description ?? ""} style={{ minHeight: 60 }} />
        </div>
        <div className="bw-grid">
          <div className="bw-field">
            <label>Price ({currency})</label>
            <input name="price" type="number" min={0} step="0.01" className="bw-input" defaultValue={p?.price ?? 0} />
          </div>
          {kind === "pack" && (
            <div className="bw-field">
              <label>Sessions included</label>
              <input name="credits" type="number" min={1} className="bw-input" defaultValue={p?.credits ?? 10} />
            </div>
          )}
          <div className="bw-field">
            <label>Valid for (days, 0 = forever)</label>
            <input name="validityDays" type="number" min={0} className="bw-input" defaultValue={p?.validityDays ?? (kind === "membership" ? 30 : 365)} />
          </div>
        </div>
        <div className="bw-field">
          <label>Usable for (none ticked = every service)</label>
          <div className="bw-row">
            {services.map((s) => (
              <label key={s.id} className="bw-check-row" style={{ marginRight: 10 }}>
                <input type="checkbox" name="serviceIds" value={s.id} defaultChecked={p?.serviceIds.includes(s.id)} /> {s.name}
              </label>
            ))}
          </div>
        </div>
        <label className="bw-check-row">
          <input type="checkbox" name="recurring" checked={recurring} disabled={!subscriptionsEnabled && !recurring} onChange={(e) => setRecurring(e.target.checked)} />
          <div>
            <div className="t">Auto-renew (subscription)</div>
            <div className="s">
              {subscriptionsEnabled
                ? "Charged automatically through Shopify checkout and renewed every period; sessions refill on each renewal. Customers cancel anytime."
                : "Needs Shopify's Subscription API access for this app: request it in the Partner Dashboard, then add the subscription scopes (see the README)."}
            </div>
          </div>
        </label>
        {recurring && (
          <div className="bw-stack" style={{ gap: 8, paddingLeft: 26 }}>
            <div className="bw-row">
              <span className="bw-help">Renews every</span>
              <input name="billingIntervalCount" type="number" min={1} max={12} defaultValue={p?.billingIntervalCount ?? 1} className="bw-input auto" style={{ width: 70 }} />
              <select name="billingInterval" className="bw-select auto" defaultValue={p?.billingInterval ?? "MONTH"}>
                <option value="WEEK">week(s)</option>
                <option value="MONTH">month(s)</option>
                <option value="YEAR">year(s)</option>
              </select>
            </div>
            <div className="bw-row">
              <button type="button" className="bw-btn sm" onClick={pickProduct}>
                {product ? "Change product" : "Link a product"}
              </button>
              <span className="bw-help">
                {product ? `Customers subscribe to: ${product.title} (its price is what they pay)` : "Pick the product customers subscribe to; create one in Shopify first if needed."}
              </span>
            </div>
          </div>
        )}
        <label className="bw-check-row">
          <input type="checkbox" name="active" defaultChecked={p?.active ?? true} /> On sale
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
      {p && (
        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm(`Delete ${p.name}?`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="id" value={p.id} />
          <button className="bw-btn sm danger">Delete package</button>
        </Form>
      )}
    </Modal>
  );
}
