import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import prisma from "../db.server";
import { verifyState } from "../models/crypto.server";
import { invalidateShop } from "../models/shop.server";
import { exchangeZoomCode, saveZoomTokens } from "../models/zoom.server";

const appUrl = () => (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");

// Zoom redirects here after the merchant approves. Register this exact URL as
// the OAuth redirect URL in your Zoom app: <app url>/oauth/zoom/callback
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shopDomain = verifyState(url.searchParams.get("state"));
  if (!code || !shopDomain) return new Response("Invalid or expired link. Start again from the app's Settings page.", { status: 400 });

  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) return new Response("Unknown shop", { status: 404 });

  try {
    await saveZoomTokens(shop.id, await exchangeZoomCode(code, `${appUrl()}/oauth/zoom/callback`));
  } catch {
    return new Response("Zoom sign-in failed. Please try connecting again.", { status: 502 });
  }
  invalidateShop(shopDomain);
  const handle = shopDomain.replace(".myshopify.com", "");
  return redirect(`https://admin.shopify.com/store/${handle}/apps/${process.env.SHOPIFY_API_KEY}/app/integrations`);
}
