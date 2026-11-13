import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { proxyShop } from "../models/storefront.server";
import { escapeHtml } from "../models/notify.server";
import { cancelContract, intervalLabel } from "../models/subscriptions.server";
import { clientIp, rateLimited } from "../models/ratelimit.server";

// /apps/booking/membership?token=... — the customer's own page for an
// auto-renewing membership (link in their welcome email): status, next
// renewal, sessions left, and a cancel button. The token is the credential.
async function find(request: Request, token: string) {
  const shop = await proxyShop(request);
  if (!shop || !token) return null;
  const cp = await prisma.customerPackage.findFirst({ where: { manageToken: token, shopId: shop.id }, include: { package: true } });
  return cp ? { shop, cp } : null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const found = await find(request, token);
  const page = (inner: string) =>
    new Response(
      `<div class="page-width" style="max-width:520px;margin:0 auto;padding:40px 16px;font-family:Inter,system-ui,sans-serif">${inner}</div>`,
      { headers: { "Content-Type": "application/liquid", "Cache-Control": "no-store" } },
    );
  if (!found) return page("<p>Use the link from your membership email to manage it.</p>");
  const { cp } = found;
  const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "—");
  const statusText: Record<string, string> = {
    active: `Active · renews ${fmt(cp.nextBillingDate)}`,
    cancelled: cp.expiresAt && cp.expiresAt > new Date() ? `Cancelled · usable until ${fmt(cp.expiresAt)}` : "Cancelled",
    paused: "Paused",
    past_due: "Paused: the last payment failed",
    expired: "Expired",
    pending: "Awaiting payment",
  };
  const canCancel = cp.subscriptionContractId && cp.status === "active";
  return page(`
    <h1 style="margin:0 0 6px">${escapeHtml(cp.package.name)}</h1>
    <p style="color:#6c6a92;margin:0 0 18px">${escapeHtml(cp.customerName)} · ${escapeHtml(cp.customerEmail)}</p>
    <div style="border:1px solid #e1e0f5;border-radius:14px;padding:18px;background:#fff">
      <p style="margin:0 0 6px"><b>${escapeHtml(statusText[cp.status] ?? cp.status)}</b></p>
      ${cp.package.recurring ? `<p style="margin:0 0 6px;color:#6c6a92">Billed ${escapeHtml(intervalLabel(cp.package.billingInterval, cp.package.billingIntervalCount))}</p>` : ""}
      <p style="margin:0;color:#6c6a92">${cp.creditsLeft === null ? "Unlimited bookings" : `${cp.creditsLeft} session(s) left this period`}</p>
    </div>
    <p style="margin:16px 0"><a href="/apps/booking/book">Book a session</a></p>
    ${
      canCancel
        ? `<button id="bw-cancel" style="padding:11px 16px;border-radius:10px;border:1px solid #f1c7c0;background:#fff;color:#b23a2e;font-weight:700;cursor:pointer">Cancel subscription</button>
           <p id="bw-msg" style="font-size:13px;color:#6c6a92"></p>
           <script>
             document.getElementById("bw-cancel").addEventListener("click", function () {
               if (!confirm("Cancel your subscription? You keep access until the end of the period you've paid for.")) return;
               var btn = this; btn.disabled = true;
               fetch("/apps/booking/membership", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: ${JSON.stringify(token).replace(/</g, "\\u003c")} }) })
                 .then(function (r) { return r.json(); })
                 .then(function (d) { document.getElementById("bw-msg").textContent = d.error || "Cancelled. You won't be charged again."; if (!d.error) btn.remove(); else btn.disabled = false; });
             });
           </script>`
        : ""
    }`);
}

export async function action({ request }: ActionFunctionArgs) {
  if (rateLimited(`membership:${clientIp(request)}`, 10, 60_000)) return json({ error: "Too many attempts." }, { status: 429 });
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // empty
  }
  const found = await find(request, String(body.token || ""));
  if (!found) return json({ error: "Not found." }, { status: 404 });
  if (found.cp.status !== "active") return json({ error: "This subscription isn't active." }, { status: 400 });
  try {
    await cancelContract(found.shop, found.cp);
  } catch {
    return json({ error: "We couldn't cancel it online. Please contact the store." }, { status: 502 });
  }
  return json({ ok: true });
}
