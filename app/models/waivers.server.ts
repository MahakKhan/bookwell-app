import prisma from "../db.server";

// Waivers: a service can require customers to read and sign a waiver before
// booking. The signature (drawn on screen), the signer's typed name, the
// exact text signed, time, IP and browser are stored with the booking.

const DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

export class WaiverError extends Error {}

export function validateSignature(input: unknown): { name: string; signature: string } {
  const w = (input && typeof input === "object" ? input : {}) as { agreed?: unknown; signature?: unknown; name?: unknown };
  const name = String(w.name ?? "").trim().slice(0, 120);
  const signature = String(w.signature ?? "");
  if (w.agreed !== true) throw new WaiverError("Please read and accept the waiver.");
  if (!name) throw new WaiverError("Type your full name to sign the waiver.");
  if (!DATA_URL_RE.test(signature) || signature.length < 1500) throw new WaiverError("Please draw your signature.");
  if (signature.length > 400_000) throw new WaiverError("That signature is too large. Please sign again.");
  return { name, signature };
}

export async function activeWaiverForService(serviceId: string) {
  const s = await prisma.service.findUnique({ where: { id: serviceId }, select: { waiver: true } });
  return s?.waiver && s.waiver.active ? s.waiver : null;
}

export async function recordSignatures(
  bookingIds: string[],
  waiver: { id: string; body: string },
  sig: { name: string; signature: string },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!bookingIds.length) return;
  await prisma.waiverSignature.createMany({
    data: bookingIds.map((bookingId) => ({
      bookingId,
      waiverId: waiver.id,
      signerName: sig.name,
      signature: sig.signature,
      waiverText: waiver.body,
      ip: meta.ip?.slice(0, 64) ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    })),
  });
}
