import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { invalidateShop } from "../models/shop.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await authenticate.webhook(request);

  // Always clear sessions (the webhook can arrive after they're gone, which
  // is why we don't gate on `session`). Booking data is kept so a
  // reinstall restores it; it is erased by the shop/redact webhook ~48h
  // later, as Shopify requires. Calendar/notification credentials are
  // wiped right away and the shop falls back to the free plan.
  await prisma.session.deleteMany({ where: { shop } });
  await prisma.shop.updateMany({
    where: { shopDomain: shop },
    data: {
      planName: "free",
      googleRefreshToken: null,
      googleAccessToken: null,
      googleTokenExpiry: null,
      resendApiKey: null,
      twilioAuthToken: null,
      zoomRefreshToken: null,
      zoomAccessToken: null,
      zoomTokenExpiry: null,
      msRefreshToken: null,
      msAccessToken: null,
      msTokenExpiry: null,
      msAccount: null,
      outlookSyncOn: false,
      outlookBlockBusy: false,
      twoWaySyncOn: false,
      googleBlockBusy: false,
      hubspotToken: null,
      klaviyoApiKey: null,
      webhookUrl: null,
      webhookSecret: null,
      apiKeyHash: null,
      apiKeyPrefix: null,
      icsToken: null,
      voiceToken: null,
      voiceEnabled: false,
    },
  });

  await prisma.externalBusy.deleteMany({ where: { shop: { shopDomain: shop } } });
  invalidateShop(shop);
  return new Response();
}
