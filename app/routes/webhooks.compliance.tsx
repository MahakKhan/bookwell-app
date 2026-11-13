import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Mandatory privacy webhooks (customers/data_request, customers/redact,
// shop/redact), all delivered to /webhooks/compliance.
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const shopRow = await prisma.shop.findUnique({ where: { shopDomain: shop } });

  switch (String(topic).toUpperCase().replace(/[\/]/g, "_")) {
    case "CUSTOMERS_DATA_REQUEST":
      // Booking data is held per customer email; the merchant fulfils the
      // export from Bookings / Customers (CSV export). Nothing to push automatically.
      break;

    case "CUSTOMERS_REDACT": {
      const c = (payload as { customer?: { email?: string; phone?: string } }).customer;
      const email = c?.email?.trim();
      const phone = c?.phone?.replace(/[^\d+]/g, "");
      if (shopRow && (email || phone)) {
        const byEmail = email ? { customerEmail: { equals: email, mode: "insensitive" as const } } : undefined;
        const byPhone = phone ? { customerPhone: { contains: phone.slice(-9) } } : undefined;
        const bookingWhere = { shopId: shopRow.id, OR: [byEmail, byPhone].filter(Boolean) as object[] };
        const ids = (await prisma.booking.findMany({ where: bookingWhere, select: { id: true } })).map((b) => b.id);
        await prisma.$transaction([
          // Signed waivers hold the person's name, signature image and IP.
          prisma.waiverSignature.deleteMany({ where: { bookingId: { in: ids } } }),
          prisma.booking.updateMany({
            where: { id: { in: ids } },
            data: { customerName: "Redacted", customerEmail: "redacted@redacted.invalid", customerPhone: null, smsOptIn: false, answers: undefined, notes: null, customerId: null },
          }),
          ...(email
            ? [
                prisma.customer.deleteMany({ where: { shopId: shopRow.id, email: { equals: email, mode: "insensitive" } } }),
                prisma.waitlistEntry.deleteMany({ where: { shopId: shopRow.id, customerEmail: { equals: email, mode: "insensitive" } } }),
                prisma.customerPackage.deleteMany({ where: { shopId: shopRow.id, customerEmail: { equals: email, mode: "insensitive" }, subscriptionContractId: null } }),
                prisma.notificationLog.deleteMany({ where: { shopId: shopRow.id, to: { equals: email, mode: "insensitive" } } }),
              ]
            : []),
          ...(phone
            ? [
                prisma.callSession.deleteMany({ where: { shopId: shopRow.id, caller: { contains: phone.slice(-9) } } }),
                prisma.notificationLog.deleteMany({ where: { shopId: shopRow.id, to: { contains: phone.slice(-9) } } }),
                prisma.waitlistEntry.deleteMany({ where: { shopId: shopRow.id, customerPhone: { contains: phone.slice(-9) } } }),
              ]
            : []),
        ]);
      }
      break;
    }

    case "SHOP_REDACT":
      // Cascades to every table owned by the shop (services, staff, bookings,
      // customers, waivers and signatures, call transcripts, logs, packages...).
      await prisma.shop.deleteMany({ where: { shopDomain: shop } });
      await prisma.session.deleteMany({ where: { shop } });
      break;
  }

  return new Response();
}
