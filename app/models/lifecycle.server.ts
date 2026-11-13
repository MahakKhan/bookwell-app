import crypto from "node:crypto";
import type { Booking, Service, Shop, StaffMember } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { isDayService, manageUrlFor } from "./booking.server";
import { decrypt } from "./crypto.server";
import { notifyCustomer, notifyMerchant, whenText, type NotifyBooking } from "./notify.server";
import { createGoogleCalendarEventFull, deleteGoogleCalendarEvent, updateGoogleCalendarEvent } from "./calendar.server";
import { formatInTz, localParts } from "./time.server";
import { refundCredits } from "./packages.server";
import { createZoomMeeting, deleteZoomMeeting, updateZoomMeeting } from "./zoom.server";
import { createOutlookEvent, deleteOutlookEvent, updateOutlookEvent } from "./microsoft.server";
import { syncBookingToHubspot } from "./hubspot.server";

// Every side effect of a booking changing state lives here, so the storefront,
// the admin, POS, the public API and the background jobs all behave the same:
// calendar sync, customer/merchant notifications, Shopify checkout / orders /
// refunds, waitlist, outgoing webhooks and Klaviyo. Nothing in here may throw
// back into the request that triggered it.

type Full = Booking & { service: Service; staff: StaffMember | null };

const loadFull = (id: string) => prisma.booking.findUnique({ where: { id }, include: { service: true, staff: true } });

function toNotify(shop: Shop, b: Full): NotifyBooking {
  return {
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
    checkoutUrl: b.checkoutUrl,
  };
}

const quiet = (p: Promise<unknown>) => p.catch((e) => console.error("[bookwell]", e));

// ---------------------------------------------------------------------------
// Shopify Admin API (offline token) for storefront/background flows.
// ---------------------------------------------------------------------------

export async function shopGraphql<T = any>(shopDomain: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const { admin } = await unauthenticated.admin(shopDomain);
  const res = await admin.graphql(query, { variables });
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Outgoing webhooks + Klaviyo
// ---------------------------------------------------------------------------

export function serializeBooking(shop: Shop, b: Full) {
  return {
    id: b.id,
    status: b.status,
    service: { id: b.serviceId, name: b.service.name, type: b.service.type },
    staff: b.staff ? { id: b.staff.id, name: b.staff.name } : null,
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    timezone: shop.timezone,
    quantity: b.quantity,
    customer: { name: b.customerName, email: b.customerEmail, phone: b.customerPhone },
    answers: b.answers ?? [],
    addons: b.addons ?? [],
    totalPrice: Number(b.totalPrice),
    amountDue: Number(b.amountDue),
    paymentStatus: b.paymentStatus,
    shopifyOrderId: b.shopifyOrderId,
    source: b.source,
    seriesId: b.seriesId,
    manageUrl: manageUrlFor(shop.shopDomain, b.manageToken),
    createdAt: b.createdAt.toISOString(),
  };
}

async function logIntegration(shop: Shop, channel: string, kind: string, to: string, ok: boolean, error?: string, bookingId?: string) {
  await prisma.notificationLog
    .create({ data: { shopId: shop.id, bookingId, channel, kind, to, status: ok ? "sent" : "failed", error: error?.slice(0, 500) } })
    .catch(() => {});
}

export async function emitEvent(shop: Shop, event: string, b: Full) {
  const data = serializeBooking(shop, b);
  const tasks: Promise<unknown>[] = [];

  if (shop.hubspotToken) {
    tasks.push(
      syncBookingToHubspot(shop, event, {
        id: b.id,
        customerName: b.customerName,
        customerEmail: b.customerEmail,
        customerPhone: b.customerPhone,
        serviceName: b.service.name,
        staffName: b.staff?.name,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        status: b.status,
        totalPrice: Number(b.totalPrice),
      }),
    );
  }

  if (shop.webhookUrl) {
    const body = JSON.stringify({ event, shop: shop.shopDomain, sentAt: new Date().toISOString(), data });
    const secret = decrypt(shop.webhookSecret) || "";
    const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");
    tasks.push(
      fetch(shop.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bookwell-Event": event, "X-Bookwell-Signature": signature },
        body,
        signal: AbortSignal.timeout(10_000),
      })
        .then((r) => logIntegration(shop, "webhook", event, shop.webhookUrl!, r.ok, r.ok ? undefined : `HTTP ${r.status}`, b.id))
        .catch((e) => logIntegration(shop, "webhook", event, shop.webhookUrl!, false, String(e), b.id)),
    );
  }

  const klaviyoKey = decrypt(shop.klaviyoApiKey);
  if (klaviyoKey) {
    const [first, ...rest] = b.customerName.split(" ");
    tasks.push(
      fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: {
          Authorization: `Klaviyo-API-Key ${klaviyoKey}`,
          revision: "2024-10-15",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          data: {
            type: "event",
            attributes: {
              properties: { ...data, customer: undefined },
              value: Number(b.totalPrice),
              unique_id: `${b.id}:${event}`,
              metric: { data: { type: "metric", attributes: { name: `Bookwell ${event}` } } },
              profile: {
                data: {
                  type: "profile",
                  attributes: { email: b.customerEmail, first_name: first, last_name: rest.join(" ") || undefined },
                },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      })
        .then(async (r) => logIntegration(shop, "klaviyo", event, b.customerEmail, r.ok, r.ok ? undefined : await r.text(), b.id))
        .catch((e) => logIntegration(shop, "klaviyo", event, b.customerEmail, false, String(e), b.id)),
    );
  }

  await Promise.all(tasks);
}

// ---------------------------------------------------------------------------
// Created / confirmed
// ---------------------------------------------------------------------------

/**
 * Runs after createBooking(). For unpaid bookings that need payment it creates
 * the Shopify checkout and returns its URL (the slot is held meanwhile);
 * otherwise it fires the confirmation side effects.
 */
export async function onBookingsCreated(shop: Shop, bookings: Booking[]): Promise<{ checkoutUrl?: string }> {
  if (!bookings.length) return {};
  if (bookings[0].status === "pending") {
    const checkoutUrl = await startCheckout(shop, bookings);
    return { checkoutUrl };
  }
  bookings.forEach((b, i) => quiet(onConfirmed(shop, b.id, { notify: i === 0 })));
  if (shop.createOrderWithoutCheckout && Number(bookings[0].totalPrice) > 0 && !bookings[0].shopifyOrderId) {
    quiet(createOrderWithoutCheckout(shop, bookings));
  }
  return {};
}

async function onConfirmed(shop: Shop, bookingId: string, opts: { notify: boolean }) {
  let b = await loadFull(bookingId);
  if (!b) return;
  // Calendar first: for auto-Meet services the confirmation must carry the link.
  const meet = b.service.autoMeet && b.service.type === "virtual";
  try {
    const ev = await createGoogleCalendarEventFull(
      shop,
      { serviceName: b.service.name, staffName: b.staff?.name ?? "", customerName: b.customerName, startsAt: b.startsAt, endsAt: b.endsAt, bookingId: b.id },
      { meet },
    );
    if (ev.id || ev.meetUrl) {
      await prisma.booking.update({
        where: { id: b.id },
        data: { ...(ev.id ? { googleEventId: ev.id } : {}), ...(ev.meetUrl ? { meetingUrl: ev.meetUrl } : {}) },
      });
      b = (await loadFull(bookingId)) ?? b;
    }
  } catch (e) {
    console.error("[bookwell] calendar", e);
  }
  const teams = b.service.autoTeams && b.service.type === "virtual";
  if ((shop.outlookSyncOn || teams) && shop.msRefreshToken && !b.outlookEventId) {
    const ev = await createOutlookEvent(
      shop,
      {
        title: `${b.service.name} — ${b.customerName}`,
        description: `Booked via Bookwell${b.staff ? ` with ${b.staff.name}` : ""}. ${b.customerEmail}${b.customerPhone ? ` · ${b.customerPhone}` : ""}`,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
      },
      { teams },
    ).catch(() => ({ id: null, joinUrl: null }));
    if (ev.id || ev.joinUrl) {
      await prisma.booking.update({
        where: { id: b.id },
        data: { ...(ev.id ? { outlookEventId: ev.id } : {}), ...(ev.joinUrl ? { meetingUrl: ev.joinUrl } : {}) },
      });
      b = (await loadFull(bookingId)) ?? b;
    }
  }
  if (b.service.autoZoom && b.service.type === "virtual" && !b.zoomMeetingId) {
    const zoom = await createZoomMeeting(shop, {
      topic: `${b.service.name} — ${b.customerName}`,
      startsAt: b.startsAt,
      durationMinutes: b.service.durationMinutes,
      agenda: `Booked via Bookwell${b.staff ? ` with ${b.staff.name}` : ""}.`,
    }).catch(() => null);
    if (zoom) {
      await prisma.booking.update({ where: { id: b.id }, data: { zoomMeetingId: zoom.id, meetingUrl: zoom.joinUrl } });
      b = (await loadFull(bookingId)) ?? b;
    }
  }
  const tasks: Promise<unknown>[] = [emitEvent(shop, "booking.created", b)];
  if (opts.notify) {
    tasks.push(notifyCustomer(shop, "confirmation", toNotify(shop, b), { sms: b.smsOptIn }));
    tasks.push(notifyMerchant(shop, toNotify(shop, b)));
  }
  await Promise.allSettled(tasks);
}

// ---------------------------------------------------------------------------
// Payments: Shopify draft-order checkout for deposits / prepayment.
// ---------------------------------------------------------------------------

async function startCheckout(shop: Shop, bookings: Booking[]) {
  const service = await prisma.service.findUnique({ where: { id: bookings[0].serviceId } });
  const amount = bookings.reduce((n, b) => n + Number(b.amountDue), 0);
  const total = bookings.reduce((n, b) => n + Number(b.totalPrice), 0);
  const when = whenText(shop, { startsAt: bookings[0].startsAt, endsAt: bookings[0].endsAt, allDay: service ? isDayService(service) : false }, true);
  const partial = amount < total;
  const title = `${service?.name ?? "Booking"}${partial ? " (deposit)" : ""}`;

  try {
    const data = await shopGraphql(
      shop.shopDomain,
      `#graphql
      mutation BookwellCheckout($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }`,
      {
        input: {
          note: `Bookwell booking ${bookings.map((b) => b.id).join(", ")}`,
          tags: ["bookwell"],
          customAttributes: [{ key: "bookwell_booking_ids", value: bookings.map((b) => b.id).join(",") }],
          lineItems: [
            {
              title,
              quantity: 1,
              requiresShipping: false,
              taxable: false,
              originalUnitPriceWithCurrency: { amount: amount.toFixed(2), currencyCode: shop.currency || "USD" },
              customAttributes: [
                { key: "Booking", value: when },
                ...(bookings.length > 1 ? [{ key: "Sessions", value: String(bookings.length) }] : []),
                ...(partial ? [{ key: "Remaining balance", value: (total - amount).toFixed(2) }] : []),
              ],
            },
          ],
        },
      },
    );
    const draft = data?.data?.draftOrderCreate?.draftOrder;
    const err = data?.data?.draftOrderCreate?.userErrors?.[0]?.message || data?.errors?.[0]?.message;
    if (!draft?.invoiceUrl) throw new Error(err || "Checkout could not be created");
    await prisma.booking.updateMany({
      where: { id: { in: bookings.map((b) => b.id) } },
      data: { draftOrderId: draft.id, checkoutUrl: draft.invoiceUrl },
    });
    return draft.invoiceUrl as string;
  } catch (e) {
    // Release the held slot: the customer can't pay, so nothing should block it.
    await prisma.booking.updateMany({
      where: { id: { in: bookings.map((b) => b.id) } },
      data: { status: "abandoned", holdExpiresAt: null, notes: `Checkout failed: ${String((e as Error).message).slice(0, 200)}` },
    });
    throw new Error("Online payment is not available right now. Please try again later or contact the store.");
  }
}

/**
 * Confirms paid checkouts and releases expired holds. Called by the
 * background job every minute, and when the merchant opens Bookings.
 */
export async function syncPendingPayments(shop: Shop) {
  const pending = await prisma.booking.findMany({
    where: { shopId: shop.id, status: "pending", draftOrderId: { not: null } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const groups = new Map<string, Booking[]>();
  for (const b of pending) groups.set(b.draftOrderId!, [...(groups.get(b.draftOrderId!) ?? []), b]);

  for (const [draftOrderId, list] of groups) {
    try {
      const data = await shopGraphql(
        shop.shopDomain,
        `#graphql
        query BookwellDraft($id: ID!) { draftOrder(id: $id) { status order { id } } }`,
        { id: draftOrderId },
      );
      const draft = data?.data?.draftOrder;
      const expired = list.every((b) => b.holdExpiresAt && b.holdExpiresAt.getTime() < Date.now());

      if (draft?.status === "COMPLETED" && draft.order?.id) {
        const partial = list.some((b) => Number(b.amountDue) < Number(b.totalPrice));
        await prisma.booking.updateMany({
          where: { id: { in: list.map((b) => b.id) }, status: "pending" },
          data: {
            status: "confirmed",
            paymentStatus: partial ? "partial" : "paid",
            shopifyOrderId: draft.order.id,
            holdExpiresAt: null,
          },
        });
        for (const b of list) await prisma.booking.update({ where: { id: b.id }, data: { depositPaid: b.amountDue } });
        list.forEach((b, i) => quiet(onConfirmed(shop, b.id, { notify: i === 0 })));
      } else if (expired || !draft) {
        await prisma.booking.updateMany({
          where: { id: { in: list.map((b) => b.id) }, status: "pending" },
          data: { status: "abandoned", holdExpiresAt: null },
        });
        if (draft) {
          quiet(
            shopGraphql(
              shop.shopDomain,
              `#graphql
              mutation BookwellDraftDelete($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId } }`,
              { input: { id: draftOrderId } },
            ),
          );
        }
      }
    } catch (e) {
      console.error("[bookwell] payment sync", e);
    }
  }
}

/** "Create a Shopify order when a booking is made without checkout." */
async function createOrderWithoutCheckout(shop: Shop, bookings: Booking[]) {
  const service = await prisma.service.findUnique({ where: { id: bookings[0].serviceId } });
  const total = bookings.reduce((n, b) => n + Number(b.totalPrice), 0);
  const created = await shopGraphql(
    shop.shopDomain,
    `#graphql
    mutation BookwellOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) { draftOrder { id } userErrors { message } }
    }`,
    {
      input: {
        note: `Bookwell booking ${bookings.map((b) => b.id).join(", ")} (pay at appointment)`,
        tags: ["bookwell"],
        lineItems: [
          {
            title: service?.name ?? "Booking",
            quantity: 1,
            requiresShipping: false,
            originalUnitPriceWithCurrency: { amount: total.toFixed(2), currencyCode: shop.currency || "USD" },
            customAttributes: [{ key: "Booking", value: whenText(shop, bookings[0], true) }],
          },
        ],
      },
    },
  );
  const draftId = created?.data?.draftOrderCreate?.draftOrder?.id;
  if (!draftId) return;
  const done = await shopGraphql(
    shop.shopDomain,
    `#graphql
    mutation BookwellComplete($id: ID!) { draftOrderComplete(id: $id, paymentPending: true) { draftOrder { order { id } } userErrors { message } } }`,
    { id: draftId },
  );
  const orderId = done?.data?.draftOrderComplete?.draftOrder?.order?.id;
  if (orderId) {
    await prisma.booking.updateMany({ where: { id: { in: bookings.map((b) => b.id) } }, data: { shopifyOrderId: orderId } });
  }
}

async function cancelShopifyOrder(shop: Shop, orderId: string, refund: boolean) {
  const attempt = (withRefundMethod: boolean) =>
    shopGraphql(
      shop.shopDomain,
      withRefundMethod
        ? `#graphql
          mutation BookwellCancel($orderId: ID!, $refundMethod: OrderCancelRefundMethodInput) {
            orderCancel(orderId: $orderId, reason: CUSTOMER, refundMethod: $refundMethod, restock: false, notifyCustomer: true) {
              orderCancelUserErrors { message }
            }
          }`
        : `#graphql
          mutation BookwellCancelLegacy($orderId: ID!, $refund: Boolean!) {
            orderCancel(orderId: $orderId, reason: CUSTOMER, refund: $refund, restock: false, notifyCustomer: true) {
              orderCancelUserErrors { message }
            }
          }`,
      withRefundMethod
        ? { orderId, refundMethod: refund ? { originalPaymentMethodsRefund: true } : null }
        : { orderId, refund },
    );
  let data = await attempt(true);
  if (data?.errors?.length) data = await attempt(false);
  const err = data?.errors?.[0]?.message || data?.data?.orderCancel?.orderCancelUserErrors?.[0]?.message;
  if (err) throw new Error(err);
}

// ---------------------------------------------------------------------------
// Cancelled / rescheduled
// ---------------------------------------------------------------------------

export async function onBookingCancelled(shop: Shop, bookingId: string, by: "customer" | "admin" | "system", opts: { notify?: boolean } = {}) {
  const b = await loadFull(bookingId);
  if (!b) return { refund: null as string | null };
  let refundNote: string | null = null;

  if (b.googleEventId) quiet(deleteGoogleCalendarEvent(shop, b.googleEventId));
  if (b.customerPackageId) await refundCredits(b.customerPackageId, 1);
  if (b.zoomMeetingId) quiet(deleteZoomMeeting(shop, b.zoomMeetingId));
  if (b.outlookEventId) quiet(deleteOutlookEvent(shop, b.outlookEventId));
  if (b.draftOrderId && !b.shopifyOrderId) {
    quiet(
      shopGraphql(
        shop.shopDomain,
        `#graphql
        mutation BookwellDraftDelete($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId } }`,
        { input: { id: b.draftOrderId } },
      ),
    );
  }

  if (b.shopifyOrderId && by !== "system") {
    const cancelOrder = by === "admin" ? shop.autoCancelOrderOnAdminCancel : shop.autoCancelOrderOnCustomerCancel;
    const refund = by === "admin" ? shop.autoRefundOnAdminCancel : shop.autoRefundOnCustomerCancel;
    if (cancelOrder || refund) {
      try {
        await cancelShopifyOrder(shop, b.shopifyOrderId, refund);
        if (refund) await prisma.booking.update({ where: { id: b.id }, data: { paymentStatus: "refunded" } });
        refundNote = refund ? "Order cancelled and refunded." : "Order cancelled.";
      } catch (e) {
        refundNote = `Booking cancelled, but the Shopify order couldn't be cancelled: ${(e as Error).message}`;
      }
    }
  }

  const tasks: Promise<unknown>[] = [emitEvent(shop, "booking.cancelled", b), notifyWaitlist(shop, b)];
  if (opts.notify !== false && b.status !== "pending") {
    tasks.push(notifyCustomer(shop, "cancellation", toNotify(shop, b), { sms: b.smsOptIn }));
  }
  await Promise.allSettled(tasks);
  return { refund: refundNote };
}

export async function onBookingRescheduled(shop: Shop, bookingId: string) {
  const b = await loadFull(bookingId);
  if (!b) return;
  const tasks: Promise<unknown>[] = [
    emitEvent(shop, "booking.rescheduled", b),
    notifyCustomer(shop, "reschedule", toNotify(shop, b), { sms: b.smsOptIn }),
  ];
  if (b.googleEventId) tasks.push(updateGoogleCalendarEvent(shop, b.googleEventId, { startsAt: b.startsAt, endsAt: b.endsAt }));
  if (b.zoomMeetingId) tasks.push(updateZoomMeeting(shop, b.zoomMeetingId, { startsAt: b.startsAt, durationMinutes: b.service.durationMinutes }));
  if (b.outlookEventId) tasks.push(updateOutlookEvent(shop, b.outlookEventId, { startsAt: b.startsAt, endsAt: b.endsAt }));
  await Promise.allSettled(tasks);
}

/** A freed slot: tell up to 5 people waiting for that service and day. */
async function notifyWaitlist(shop: Shop, b: Full) {
  const date = localParts(b.startsAt, shop.timezone).dateStr;
  const entries = await prisma.waitlistEntry.findMany({
    where: {
      shopId: shop.id,
      serviceId: b.serviceId,
      date,
      status: "waiting",
      OR: [{ staffId: null }, { staffId: b.staffId }],
    },
    orderBy: { createdAt: "asc" },
    take: 5,
  });
  for (const e of entries) {
    await notifyCustomer(shop, "waitlist", {
      customerEmail: e.customerEmail,
      customerName: e.customerName,
      customerPhone: e.customerPhone,
      serviceName: b.service.name,
      startsAt: e.startsAt ?? b.startsAt,
      allDay: isDayService(b.service),
      manageUrl: bookPageUrl(shop.shopDomain, b.serviceId, date),
    });
    await prisma.waitlistEntry.update({ where: { id: e.id }, data: { status: "notified", notifiedAt: new Date() } });
  }
}

export function qrUrlFor(shopDomain: string, token: string) {
  return `https://${shopDomain}/apps/booking/qrcode?token=${encodeURIComponent(token)}`;
}

export function bookPageUrl(shopDomain: string, serviceId?: string, date?: string) {
  const q = new URLSearchParams();
  if (serviceId) q.set("service", serviceId);
  if (date) q.set("date", date);
  const s = q.toString();
  return `https://${shopDomain}/apps/booking/book${s ? `?${s}` : ""}`;
}

export function formatBookingWhen(shop: Shop, b: { startsAt: Date; endsAt: Date }, service: { type: string }) {
  if (isDayService(service)) return whenText(shop, { startsAt: b.startsAt, endsAt: b.endsAt, allDay: true }, true);
  return formatInTz(b.startsAt, shop.timezone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: !shop.use24h,
  });
}
