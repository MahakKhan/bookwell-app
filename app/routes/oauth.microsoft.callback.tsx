import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import prisma from "../db.server";
import { verifyState } from "../models/crypto.server";
import { invalidateShop } from "../models/shop.server";
import { connectMicrosoft } from "../models/microsoft.server";

const appUrl = () => (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");

// Microsoft redirects here after the merchant signs in. Register this exact
// redirect URI in the Azure app: <app url>/oauth/microsoft/callback
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return new Response(`Microsoft declined: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`, { status: 400 });
  const shopDomain = verifyState(url.searchParams.get("state"));
  if (!code || !shopDomain) return new Response("Invalid or expired link. Start again from the app's Integrations page.", { status: 400 });
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) return new Response("Unknown shop", { status: 404 });
  try {
    await connectMicrosoft(shop.id, code, `${appUrl()}/oauth/microsoft/callback`);
  } catch {
    return new Response("Microsoft sign-in failed. Please try connecting again.", { status: 502 });
  }
  invalidateShop(shopDomain);
  const handle = shopDomain.replace(".myshopify.com", "");
  return redirect(`https://admin.shopify.com/store/${handle}/apps/${process.env.SHOPIFY_API_KEY}/app/integrations`);
}
