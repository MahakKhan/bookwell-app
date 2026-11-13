import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import prisma from "../db.server";
import { exchangeCodeForTokens } from "../models/calendar.server";
import { encrypt, verifyState } from "../models/crypto.server";
import { invalidateShop } from "../models/shop.server";

const appUrl = () => (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");

// Google redirects here as a bare top-level navigation, so there's no Shopify
// session (and this route deliberately lives OUTSIDE /app, whose layout
// requires one). The signed, expiring `state` proves which shop started it.
// Register this exact URL in Google Cloud Console: <app url>/oauth/google/callback
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) return new Response(`Google declined: ${error}`, { status: 400 });

  const shopDomain = verifyState(url.searchParams.get("state"));
  if (!code || !shopDomain) return new Response("Invalid or expired link. Start again from the app's Settings page.", { status: 400 });

  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) return new Response("Unknown shop", { status: 404 });

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, `${appUrl()}/oauth/google/callback`);
  } catch {
    return new Response("Google sign-in failed. Please try connecting again.", { status: 502 });
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      googleAccessToken: encrypt(tokens.access_token),
      googleRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : shop.googleRefreshToken,
      googleTokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
      twoWaySyncOn: true,
    },
  });
  invalidateShop(shopDomain);
  const handle = shopDomain.replace(".myshopify.com", "");
  return redirect(`https://admin.shopify.com/store/${handle}/apps/${process.env.SHOPIFY_API_KEY}/app/integrations`);
}
