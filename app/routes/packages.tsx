import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { proxyShop } from "../models/storefront.server";
import { buyPackage } from "../models/packages.server";
import { EMAIL_RE } from "../models/submit.server";
import { escapeHtml } from "../models/notify.server";
import { clientIp, rateLimited } from "../models/ratelimit.server";
import { intervalLabel } from "../models/subscriptions.server";

const numericId = (gid: string | null) => (gid ? gid.split("/").pop() : "");

// /apps/booking/packages on the storefront: lists class packs & memberships
// for sale (rendered inside the theme as Liquid) and handles purchases.
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await proxyShop(request);
  if (!shop) return new Response("Unknown shop", { status: 401 });
  const packages = await prisma.package.findMany({ where: { shopId: shop.id, active: true }, orderBy: { price: "asc" } });
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: shop.currency }).format(n);
    } catch {
      return n.toFixed(2);
    }
  };
  const cards = packages
    .filter((p) => !p.recurring || (p.sellingPlanId && p.variantId))
    .map(
      (p) => p.recurring ? `
      <div class="bw-pkg" style="border:1px solid #e1e0f5;border-radius:14px;padding:18px;background:#fff">
        <h3 style="margin:0 0 4px">${escapeHtml(p.name)}</h3>
        <p style="margin:0;color:#6c6a92">${p.kind === "membership" ? "Unlimited bookings" : `${p.credits} sessions`} · renews ${escapeHtml(intervalLabel(p.billingInterval, p.billingIntervalCount))}</p>
        ${p.description ? `<p style="margin:8px 0 0;color:#6c6a92">${escapeHtml(p.description)}</p>` : ""}
        <p style="font-size:20px;font-weight:700;margin:12px 0">${escapeHtml(fmt(Number(p.price)))} <span style="font-size:13px;font-weight:500;color:#6c6a92">${escapeHtml(intervalLabel(p.billingInterval, p.billingIntervalCount))}</span></p>
        <button type="button" data-sub-variant="${escapeHtml(numericId(p.variantId) ?? "")}" data-sub-plan="${escapeHtml(numericId(p.sellingPlanId) ?? "")}" style="width:100%;padding:12px;border:none;border-radius:10px;background:${escapeHtml(shop.widgetAccent)};color:#fff;font-weight:700;cursor:pointer">Subscribe</button>
        <p style="margin:8px 0 0;font-size:12px;color:#6c6a92">Cancel anytime from the link in your welcome email.</p>
      </div>` : `
      <div class="bw-pkg" style="border:1px solid #e1e0f5;border-radius:14px;padding:18px;background:#fff">
        <h3 style="margin:0 0 4px">${escapeHtml(p.name)}</h3>
        <p style="margin:0;color:#6c6a92">${p.kind === "membership" ? "Unlimited bookings" : `${p.credits} sessions`}${p.validityDays ? ` · valid ${p.validityDays} days` : ""}</p>
        ${p.description ? `<p style="margin:8px 0 0;color:#6c6a92">${escapeHtml(p.description)}</p>` : ""}
        <p style="font-size:20px;font-weight:700;margin:12px 0">${escapeHtml(Number(p.price) > 0 ? fmt(Number(p.price)) : "Free")}</p>
        <form data-pkg="${escapeHtml(p.id)}" style="display:flex;flex-direction:column;gap:8px">
          <input name="name" placeholder="Full name" required style="padding:10px;border:1px solid #e1e0f5;border-radius:9px">
          <input name="email" type="email" placeholder="Email" required style="padding:10px;border:1px solid #e1e0f5;border-radius:9px">
          <button type="submit" style="padding:12px;border:none;border-radius:10px;background:${escapeHtml(shop.widgetAccent)};color:#fff;font-weight:700;cursor:pointer">Buy</button>
          <p class="bw-pkg-msg" style="margin:0;font-size:13px;color:#b23a2e"></p>
        </form>
      </div>`,
    )
    .join("");
  const script = `<script>
    document.querySelectorAll("button[data-sub-variant]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        fetch("/cart/add.js", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ id: Number(b.dataset.subVariant), quantity: 1, selling_plan: Number(b.dataset.subPlan) }] }) })
          .then(function (r) { if (!r.ok) throw new Error(); window.location.href = "/checkout"; })
          .catch(function () { b.disabled = false; alert("Couldn't start the subscription. Please try again."); });
      });
    });
    document.querySelectorAll("form[data-pkg]").forEach(function (f) {
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var msg = f.querySelector(".bw-pkg-msg"); msg.textContent = "";
        var btn = f.querySelector("button"); btn.disabled = true;
        fetch("/apps/booking/packages", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ packageId: f.dataset.pkg, name: f.name.value, email: f.email.value }) })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            btn.disabled = false;
            if (!res.ok) { msg.textContent = res.d.error || "Something went wrong."; return; }
            if (res.d.checkoutUrl) { window.location.href = res.d.checkoutUrl; return; }
            msg.style.color = "#1f8a5f"; msg.textContent = "Done! Use this email when you book.";
          })
          .catch(function () { btn.disabled = false; msg.textContent = "Something went wrong."; });
      });
    });
  </script>`;
  return new Response(
    `<div class="page-width" style="max-width:960px;margin:0 auto;padding:32px 16px;font-family:Inter,system-ui,sans-serif">` +
      `<h1 style="margin:0 0 6px">Packages &amp; memberships</h1>` +
      `<p style="color:#6c6a92;margin:0 0 20px">Buy once, then book with the same email. <a href="/apps/booking/book">Book a service</a></p>` +
      (packages.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px">${cards}</div>` : "<p>No packages are on sale right now.</p>") +
      `</div>${script}`,
    { headers: { "Content-Type": "application/liquid", "Cache-Control": "no-store" } },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const shop = await proxyShop(request);
  if (!shop) return json({ error: "Unknown shop" }, { status: 401 });
  if (rateLimited(`pkg:${clientIp(request)}`, 6, 60_000)) return json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, { status: 400 });
  }
  const name = String(body.name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  if (!name || !EMAIL_RE.test(email)) return json({ error: "Enter your name and a valid email." }, { status: 400 });
  try {
    const { checkoutUrl } = await buyPackage(shop, String(body.packageId || ""), { name, email });
    return json({ checkoutUrl });
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 });
  }
}
