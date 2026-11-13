import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import crypto from "node:crypto";
import {
  cancelBookingsForCancelledOrders,
  sendDueReminders,
  syncAllPendingPayments,
  weeklyBillingReconciliation,
} from "../models/jobs.server";

// Optional external trigger for the background jobs (they also run in-process
// every few minutes, see jobs.server.ts). Useful when the server sleeps
// between requests (e.g. a free Render instance).
//
// Authenticated by a shared secret (CRON_SECRET) in the X-Cron-Secret header
// or "Authorization: Bearer" — NOT a query string, which would end up in logs.
export async function loader({ request }: LoaderFunctionArgs) {
  return handle(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handle(request);
}

function secretMatches(provided: string | null) {
  const expected = process.env.CRON_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(request: Request) {
  const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const secret = request.headers.get("X-Cron-Secret") || bearer;
  if (!secretMatches(secret)) return json({ error: "Unauthorized" }, { status: 401 });

  const payments = await syncAllPendingPayments();
  const reminders = await sendDueReminders();
  await cancelBookingsForCancelledOrders();
  const reconciled = await weeklyBillingReconciliation();
  return json({ ...reminders, paymentShops: payments, reconciled });
}
