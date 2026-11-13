import prisma from "../db.server";
import { isPaid } from "../plans";
import { isDayService, manageUrlFor, cancelBookingById } from "./booking.server";
import { notifyCustomer } from "./notify.server";
import { onBookingCancelled, qrUrlFor, shopGraphql, syncPendingPayments } from "./lifecycle.server";
import { reconcileShopBilling } from "./billing.server";
import { syncPackages } from "./packages.server";
import { runRenewals, syncSubscriptionContracts } from "./subscriptions.server";
import { syncGoogleBusy } from "./calendar.server";
import { syncOutlookBusy } from "./microsoft.server";

// Background work. Runs in-process (started once from entry.server.tsx) so a
// single server needs no external scheduler, and is also exposed through
// /api/reminders/send for setups that prefer an external cron.

/** Reminders `emailReminderHours` before each confirmed booking, sent once. */
export async function sendDueReminders() {
  const now = new Date();
  const shops = await prisma.shop.findMany({
    where: { bookings: { some: { status: "confirmed", reminderSentAt: null, startsAt: { gt: now } } } },
  });
  let sent = 0;
  let checked = 0;
  for (const shop of shops) {
    const hours = Math.max(1, shop.emailReminderHours || 24);
    const bookings = await prisma.booking.findMany({
      where: {
        shopId: shop.id,
        status: "confirmed",
        reminderSentAt: null,
        startsAt: { gt: now, lte: new Date(now.getTime() + hours * 60 * 60_000) },
        // Don't "remind" someone who booked minutes ago.
        createdAt: { lt: new Date(now.getTime() - 60 * 60_000) },
      },
      include: { service: true, staff: true },
      take: 200,
    });
    for (const b of bookings) {
      checked += 1;
      const ok = await notifyCustomer(
        shop,
        "reminder",
        {
          id: b.id,
          customerEmail: b.customerEmail,
          customerName: b.customerName,
          customerPhone: b.customerPhone,
          serviceName: b.service.name,
          staffName: b.staff?.name,
          startsAt: b.startsAt,
          endsAt: b.endsAt,
          allDay: isDayService(b.service),
          quantity: b.quantity,
          manageUrl: manageUrlFor(shop.shopDomain, b.manageToken),
          qrUrl: qrUrlFor(shop.shopDomain, b.manageToken),
          icsUrl: `https://${shop.shopDomain}/apps/booking/ics?token=${encodeURIComponent(b.manageToken)}`,
          meetingUrl: b.meetingUrl,
        },
        { sms: b.smsOptIn },
      );
      if (ok) sent += 1;
      // Mark handled either way so an unconfigured provider isn't retried forever.
      await prisma.booking.update({ where: { id: b.id }, data: { reminderSentAt: now } });
    }
  }
  return { checked, sent };
}

export async function syncAllPendingPayments() {
  const shops = await prisma.shop.findMany({
    where: { bookings: { some: { status: "pending", draftOrderId: { not: null } } } },
  });
  for (const shop of shops) await syncPendingPayments(shop);
  const pkgShops = await prisma.shop.findMany({
    where: { customerPackages: { some: { status: { in: ["pending", "active"] } } } },
  });
  for (const shop of pkgShops) await syncPackages(shop);
  // Pending bookings that never got a checkout (e.g. crashed mid-request).
  await prisma.booking.updateMany({
    where: { status: "pending", draftOrderId: null, holdExpiresAt: { lt: new Date() } },
    data: { status: "abandoned", holdExpiresAt: null },
  });
  return shops.length;
}

/** "Automatically cancel a booking when its order is cancelled by admin." */
export async function cancelBookingsForCancelledOrders() {
  const shops = await prisma.shop.findMany({ where: { autoCancelBookingOnOrderCancel: true } });
  for (const shop of shops) {
    const bookings = await prisma.booking.findMany({
      where: { shopId: shop.id, status: "confirmed", shopifyOrderId: { not: null }, startsAt: { gt: new Date() } },
      select: { id: true, shopifyOrderId: true },
      take: 100,
    });
    if (!bookings.length) continue;
    try {
      const ids = [...new Set(bookings.map((b) => b.shopifyOrderId!))];
      const data = await shopGraphql(
        shop.shopDomain,
        `#graphql
        query BookwellOrders($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id cancelledAt } } }`,
        { ids },
      );
      const cancelled = new Set(
        (data?.data?.nodes ?? []).filter((n: any) => n?.cancelledAt).map((n: any) => n.id as string),
      );
      for (const b of bookings) {
        if (!cancelled.has(b.shopifyOrderId!)) continue;
        if (await cancelBookingById(shop.id, b.id, "system")) await onBookingCancelled(shop, b.id, "system");
      }
    } catch (e) {
      console.error("[bookwell] order sync", e);
    }
  }
}

export async function weeklyBillingReconciliation() {
  let reconciled = 0;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const paidShops = await prisma.shop.findMany({
    where: { planName: { not: "free" } },
    select: { shopDomain: true, planName: true, id: true },
  });
  for (const shop of paidShops) {
    if (!isPaid(shop.planName)) continue;
    const recent = await prisma.billingReconciliation.findFirst({
      where: { shopId: shop.id, ranAt: { gte: weekAgo } },
      select: { id: true },
    });
    if (recent) continue;
    try {
      if (await reconcileShopBilling(shop.shopDomain)) reconciled += 1;
    } catch {
      // A shop that uninstalled has no session; skip it.
    }
  }
  return reconciled;
}

declare global {
  // eslint-disable-next-line no-var
  var bookwellJobsStarted: boolean | undefined;
}

function every(ms: number, fn: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error("[bookwell] job", e);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, ms);
  t.unref?.();
  setTimeout(tick, 15_000).unref?.();
}

export function startBackgroundJobs() {
  if (global.bookwellJobsStarted || process.env.BOOKWELL_DISABLE_JOBS === "true") return;
  global.bookwellJobsStarted = true;
  every(60_000, syncAllPendingPayments);
  every(15 * 60_000, sendDueReminders);
  every(30 * 60_000, cancelBookingsForCancelledOrders);
  every(6 * 60 * 60_000, weeklyBillingReconciliation);
  every(5 * 60_000, syncAllGoogleBusy);
  every(10 * 60_000, syncAllSubscriptions);
}

/** Two-way Google sync: refresh each shop's busy times every 5 minutes. */
export async function syncAllGoogleBusy() {
  const shops = await prisma.shop.findMany({ where: { googleBlockBusy: true, googleRefreshToken: { not: null } } });
  for (const shop of shops) await syncGoogleBusy(shop).catch((e) => console.error("[bookwell] google busy", e));
  const ms = await prisma.shop.findMany({ where: { outlookBlockBusy: true, msRefreshToken: { not: null } } });
  for (const shop of ms) await syncOutlookBusy(shop).catch((e) => console.error("[bookwell] outlook busy", e));
}

/** Auto-renewing memberships: pick up new/cancelled contracts and bill renewals. */
export async function syncAllSubscriptions() {
  const shops = await prisma.shop.findMany({ where: { packages: { some: { sellingPlanId: { not: null } } } } });
  for (const shop of shops) {
    await syncSubscriptionContracts(shop).catch((e) => console.error("[bookwell] contracts", e));
    await runRenewals(shop).catch((e) => console.error("[bookwell] renewals", e));
  }
}
