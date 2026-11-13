import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { decrypt } from "./crypto.server";

// HubSpot: with a private-app token (scopes crm.objects.contacts.write,
// crm.objects.contacts.read), every booking upserts the customer as a contact
// and logs it on their timeline as a meeting (booked / rescheduled) or a note
// (cancelled).

const API = "https://api.hubapi.com";

async function hs(token: string, path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string })?.message || `HubSpot error ${res.status}`);
  return data as any;
}

export async function hubspotPing(token: string) {
  const res = await fetch(`${API}/crm/v3/objects/contacts?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(res.status === 401 ? "That token was rejected." : `HubSpot error ${res.status}`);
}

export async function syncBookingToHubspot(
  shop: Shop,
  event: string,
  b: { id: string; customerName: string; customerEmail: string; customerPhone: string | null; serviceName: string; staffName?: string | null; startsAt: Date; endsAt: Date; status: string; totalPrice: number },
) {
  const token = decrypt(shop.hubspotToken);
  if (!token) return;
  let ok = true;
  let error: string | undefined;
  try {
    const [first, ...rest] = b.customerName.trim().split(/\s+/);
    const up = await hs(token, "/crm/v3/objects/contacts/batch/upsert", {
      inputs: [
        {
          idProperty: "email",
          id: b.customerEmail,
          properties: { email: b.customerEmail, firstname: first || "", lastname: rest.join(" "), ...(b.customerPhone ? { phone: b.customerPhone } : {}) },
        },
      ],
    });
    const contactId = up?.results?.[0]?.id;
    if (!contactId) throw new Error("Contact upsert returned no id");

    if (event === "booking.cancelled") {
      await hs(token, "/crm/v3/objects/notes", {
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: `Booking cancelled: ${b.serviceName} on ${b.startsAt.toISOString()} (Bookwell ${b.id})` },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
      });
    } else {
      await hs(token, "/crm/v3/objects/meetings", {
        properties: {
          hs_timestamp: b.startsAt.toISOString(),
          hs_meeting_title: `${b.serviceName}${event === "booking.rescheduled" ? " (rescheduled)" : ""}`,
          hs_meeting_body: `Booked via Bookwell${b.staffName ? ` with ${b.staffName}` : ""}. Total: ${b.totalPrice}. Booking ${b.id}.`,
          hs_meeting_start_time: b.startsAt.toISOString(),
          hs_meeting_end_time: b.endsAt.toISOString(),
          hs_meeting_outcome: "SCHEDULED",
        },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 200 }] }],
      });
    }
  } catch (e) {
    ok = false;
    error = (e as Error).message;
  }
  await prisma.notificationLog
    .create({ data: { shopId: shop.id, bookingId: b.id, channel: "hubspot", kind: event, to: b.customerEmail, status: ok ? "sent" : "failed", error: error?.slice(0, 500) } })
    .catch(() => {});
}
