import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Marks a booking's deposit as paid once the matching Shopify order
// clears. The booking is linked to the order id when it's created
// (see routes/api.bookings.tsx), so this just closes the loop.
export async function action({ request }: ActionFunctionArgs) {
  const { payload } = await authenticate.webhook(request);
  const order = payload as { id: number; current_total_price?: string };

  await prisma.booking.updateMany({
    where: { shopifyOrderId: String(order.id) },
    data: { depositPaid: Number(order.current_total_price ?? 0) },
  });

  return new Response();
}
