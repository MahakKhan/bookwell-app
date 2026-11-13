import prisma from "../db.server";

// Audit trail for customers' personal data. We record WHO opened or exported
// it, WHAT kind of access it was and HOW MANY records, never the personal data
// itself. Logging must never break the page, so failures are swallowed.

type Actor = { id?: string; shop?: string; onlineAccessInfo?: { associated_user?: { id?: number } } | null };

export function actorOf(session: Actor) {
  const uid = session.onlineAccessInfo?.associated_user?.id;
  return uid ? `user:${uid}` : `shop:${session.shop ?? "unknown"}`;
}

export async function logAccess(
  shopId: string,
  session: Actor,
  action: string,
  records: number,
  detail?: string,
) {
  try {
    await prisma.accessLog.create({
      data: { shopId, actor: actorOf(session), action, records, detail: detail?.slice(0, 200) },
    });
  } catch {
    /* never block the request on audit logging */
  }
}

/** Keep 12 months of access logs. Called from the daily job. */
export async function purgeOldAccessLogs(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - 12);
  return prisma.accessLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
}
