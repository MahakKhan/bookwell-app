// Pricing: every feature on every plan. Plans differ only in how many
// bookings a shop can take per 30-day cycle and how many team members are
// included. Shared by client and server (no process.env here).
//
// The Shopify subscription name is the source of truth for the plan, e.g.
// "Growth" or "Growth +2 seats" (extra team seats are part of the price).

export type Plan = {
  key: string;
  name: string;
  price: number; // USD per 30 days
  bookings: number | null; // per cycle; null = unlimited
  seats: number; // team members included
  recommended?: boolean;
  popular?: boolean;
};

export const PLANS: Plan[] = [
  { key: "free", name: "Free", price: 0, bookings: 10, seats: 1 },
  { key: "starter", name: "Starter", price: 9.99, bookings: 75, seats: 3, popular: true },
  { key: "basic", name: "Basic", price: 24.99, bookings: 250, seats: 3 },
  { key: "growth", name: "Growth", price: 49.99, bookings: 600, seats: 3, recommended: true },
  { key: "pro", name: "Pro", price: 89.99, bookings: 1200, seats: 3 },
  { key: "scale", name: "Scale", price: 129.99, bookings: 2000, seats: 3 },
  { key: "unlimited", name: "Unlimited", price: 249.99, bookings: null, seats: 3 },
];

export const SEAT_PRICE = 4.99;
export const TRIAL_DAYS = 7;
export const CYCLE_DAYS = 30;
/** Online bookings keep working up to this share of the limit, so a busy day never turns customers away instantly. */
export const GRACE = 1.2;

export const FREE_PLAN = PLANS[0];

// Old plan names from before the tiered pricing.
const LEGACY: Record<string, string> = { Entry: "starter", paid: "starter" };

/** Parses a stored plan name ("Growth +2 seats") into its plan and extra seats. */
export function parsePlan(planName: string | null | undefined): { plan: Plan; extraSeats: number } {
  const m = /^(.+?)(?: \+(\d+) seats?)?$/.exec(String(planName || "").trim());
  const base = m?.[1] ?? "";
  const plan =
    PLANS.find((p) => p.name.toLowerCase() === base.toLowerCase()) ??
    PLANS.find((p) => p.key === LEGACY[base]) ??
    FREE_PLAN;
  return { plan, extraSeats: plan.price > 0 ? Number(m?.[2] ?? 0) : 0 };
}

export function subscriptionName(plan: Plan, extraSeats: number) {
  return extraSeats > 0 ? `${plan.name} +${extraSeats} seat${extraSeats === 1 ? "" : "s"}` : plan.name;
}

export function subscriptionPrice(plan: Plan, extraSeats: number) {
  return Math.round((plan.price + extraSeats * SEAT_PRICE) * 100) / 100;
}

export function seatsAllowed(planName: string) {
  const { plan, extraSeats } = parsePlan(planName);
  return plan.seats + extraSeats;
}

export function isPaid(planName: string) {
  return parsePlan(planName).plan.price > 0;
}

/** The next plan up (for "Upgrade now"), or null at the top. */
export function nextPlan(plan: Plan) {
  const i = PLANS.findIndex((p) => p.key === plan.key);
  return PLANS[i + 1] ?? null;
}
