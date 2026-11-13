import { useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { unbookableServices } from "../models/booking.server";
import { useAppLink } from "../components/ui";
import { addDays, formatInTz, localParts, weekdayOf, zonedToUtc } from "../models/time.server";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, redirect } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  if (!shop.onboardingDoneAt) {
    const services = await prisma.service.count({ where: { shopId: shop.id } });
    if (!services) return redirect("/app/onboarding");
  }
  const tz = shop.timezone;

  const url = new URL(request.url);
  const offset = Math.max(-52, Math.min(52, Number(url.searchParams.get("w")) || 0));

  const now = new Date();
  const today = localParts(now, tz).dateStr;
  const dayStart = zonedToUtc(today, 0, tz);
  const dayEnd = zonedToUtc(addDays(today, 1), 0, tz);
  const weekAhead = zonedToUtc(addDays(today, 7), 0, tz);

  // Calendar week = Monday..Sunday containing (today + offset weeks), in store time.
  const anchor = addDays(today, offset * 7);
  const monday = addDays(anchor, -((weekdayOf(anchor) + 6) % 7));
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const weekStart = zonedToUtc(monday, 0, tz);
  const weekEnd = zonedToUtc(addDays(monday, 7), 0, tz);

  const monthPrefix = today.slice(0, 7);
  const monthStart = zonedToUtc(`${monthPrefix}-01`, 0, tz);
  const monthEnd = zonedToUtc(addDays(`${monthPrefix}-28`, 4).slice(0, 7) + "-01", 0, tz);
  const thirtyAgo = new Date(now.getTime() - 30 * 24 * 60 * 60_000);

  // Three queries in parallel instead of eight: the database is remote, so
  // every round trip is expensive. Timestamps are passed as ISO strings cast
  // to `timestamp` (the columns are UTC without a zone).
  const ts = (d: Date) => d.toISOString();
  const [statsRows, weekRows, lastReconciliation, unbookable] = await Promise.all([
    prisma.$queryRaw<
      { today: number; week: number; revenue: number; recent_total: number; recent_cancelled: number }[]
    >`
      SELECT
        count(*) FILTER (WHERE b.status = 'confirmed' AND b."startsAt" >= ${ts(dayStart)}::timestamp AND b."startsAt" < ${ts(dayEnd)}::timestamp)::int AS today,
        count(*) FILTER (WHERE b.status = 'confirmed' AND b."startsAt" >= ${ts(dayStart)}::timestamp AND b."startsAt" < ${ts(weekAhead)}::timestamp)::int AS week,
        COALESCE(sum(b."totalPrice") FILTER (WHERE b.status IN ('confirmed', 'completed') AND b."startsAt" >= ${ts(monthStart)}::timestamp AND b."startsAt" < ${ts(monthEnd)}::timestamp), 0)::float8 AS revenue,
        count(*) FILTER (WHERE b."createdAt" >= ${ts(thirtyAgo)}::timestamp)::int AS recent_total,
        count(*) FILTER (WHERE b.status = 'cancelled' AND b."createdAt" >= ${ts(thirtyAgo)}::timestamp)::int AS recent_cancelled
      FROM "Booking" b
      JOIN "Service" s ON s.id = b."serviceId"
      WHERE b."shopId" = ${shop.id}`,
    prisma.$queryRaw<
      {
        id: string;
        startsAt: Date;
        service: string;
        customerName: string;
        customerEmail: string;
        staff: string;
        staffRank: number;
      }[]
    >`
      SELECT b.id, b."startsAt", s.name AS service, b."customerName", b."customerEmail", COALESCE(st.name, '—') AS staff,
        COALESCE((SELECT count(*) FROM "StaffMember" x WHERE x."shopId" = b."shopId" AND x."createdAt" < st."createdAt"), 0)::int AS "staffRank"
      FROM "Booking" b
      JOIN "Service" s ON s.id = b."serviceId"
      LEFT JOIN "StaffMember" st ON st.id = b."staffId"
      WHERE b."shopId" = ${shop.id} AND b.status IN ('confirmed', 'pending', 'completed')
        AND b."startsAt" >= ${ts(weekStart)}::timestamp AND b."startsAt" < ${ts(weekEnd)}::timestamp
      ORDER BY b."startsAt" ASC`,
    prisma.billingReconciliation.findFirst({ where: { shopId: shop.id }, orderBy: { ranAt: "desc" } }),
    unbookableServices(shop.id),
  ]);

  const st = statsRows[0] ?? { today: 0, week: 0, revenue: 0, recent_total: 0, recent_cancelled: 0 };
  const todayCount = st.today;
  const weekCount = st.week;
  const revenue = st.revenue;
  const recentTotal = st.recent_total;
  const cancelRate = recentTotal ? Math.round((st.recent_cancelled / recentTotal) * 1000) / 10 : 0;

  const events = weekRows
    .map((b) => {
      const startsAt = new Date(b.startsAt);
      const lp = localParts(startsAt, tz);
      return {
        id: b.id,
        day: weekDates.indexOf(lp.dateStr),
        minute: lp.minute,
        tone: b.staffRank % 2 === 0 ? "teal" : "amber",
        service: b.service,
        customer: b.customerName,
        email: b.customerEmail,
        staff: b.staff,
        time: formatInTz(startsAt, tz, { hour: "numeric", minute: "2-digit" }),
        full: formatInTz(startsAt, tz, {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      };
    })
    .filter((e) => e.day >= 0);

  const minHour = Math.min(9, ...events.map((e) => Math.floor(e.minute / 60)));
  const maxHour = Math.max(17, ...events.map((e) => Math.floor(e.minute / 60) + 1));

  const first = weekDates[0].split("-").map(Number);
  const last = weekDates[6].split("-").map(Number);
  const weekLabel =
    offset === 0
      ? "This week"
      : `${MONTHS[first[1] - 1]} ${first[2]} – ${MONTHS[last[1] - 1]} ${last[2]}`;

  return json({
    unbookable,
    plan: shop.planName,
    stats: { todayCount, weekCount, revenue, cancelRate, recentTotal },
    toggles: { sms: shop.smsEnabled, sync: shop.twoWaySyncOn },
    calendar: {
      offset,
      weekLabel,
      today,
      days: weekDates.map((d) => {
        const [, m, dd] = d.split("-").map(Number);
        return { date: d, dow: DOW[weekdayOf(d)], label: `${MONTHS[m - 1]} ${dd}` };
      }),
      hours: Array.from({ length: maxHour - minHour }, (_, i) => minHour + i),
      events,
    },
    reconciliation: lastReconciliation
      ? { ranAt: lastReconciliation.ranAt.toISOString(), mismatches: lastReconciliation.mismatches }
      : null,
  });
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;

export default function Dashboard() {
  const { stats, calendar, toggles, reconciliation, plan, unbookable } = useLoaderData<typeof loader>();
  const link = useAppLink();
  const [open, setOpen] = useState<(typeof calendar.events)[number] | null>(null);
  const [params] = useSearchParams();
  // Keep Shopify's shop/host params when changing week (a bare "?w=1" drops them).
  const weekLink = (w: number) => {
    const next = new URLSearchParams(params);
    next.set("w", String(w));
    return `?${next.toString()}`;
  };

  return (
    <div>
      <h1 className="bw-page-title">Dashboard</h1>
      {unbookable.map((u) => (
        <div key={u.id} className="bw-alert err">
          <b>{u.name}</b> can't be booked: {u.reason.toLowerCase()}.{" "}
          <Link to={link(u.reason.includes("team") ? "/app/staff" : `/app/services/${u.id}`)}>Fix it</Link>
        </div>
      ))}

      <div className="bw-stats">
        <div className="bw-card bw-stat">
          <div className="label">Today's bookings</div>
          <div className="value tabular">{stats.todayCount}</div>
          <div className="sub">confirmed</div>
        </div>
        <div className="bw-card bw-stat">
          <div className="label">Upcoming (7d)</div>
          <div className="value tabular">{stats.weekCount}</div>
          <div className="sub">next 7 days</div>
        </div>
        <div className="bw-card bw-stat">
          <div className="label">Cancellations (30d)</div>
          <div className="value tabular">{stats.cancelRate}%</div>
          <div className={`sub${stats.cancelRate > 15 ? " warn" : ""}`}>of {stats.recentTotal} bookings</div>
        </div>
        <div className="bw-card bw-stat">
          <div className="label">Revenue booked</div>
          <div className="value tabular">${stats.revenue.toLocaleString("en-US", { maximumFractionDigits: 2 })}</div>
          <div className="sub">this month</div>
        </div>
      </div>

      <div className="bw-stack" style={{ gap: 18 }}>
        <div className="bw-card">
          <div className="bw-cal-head">
            <div className="title">{calendar.weekLabel}</div>
            <div className="bw-cal-nav">
              <Link to={weekLink(calendar.offset - 1)} aria-label="Previous week">
                &larr;
              </Link>
              <Link to={weekLink(0)} aria-label="This week" style={{ fontSize: 11, width: "auto", padding: "0 8px" }}>
                Today
              </Link>
              <Link to={weekLink(calendar.offset + 1)} aria-label="Next week">
                &rarr;
              </Link>
            </div>
          </div>
          <div className="bw-cal-scroll">
            <div className="bw-cal-grid">
              <div className="corner" />
              {calendar.days.map((d) => (
                <div key={d.date} className={`daycol${d.date === calendar.today ? " today" : ""}`}>
                  <div className="d">{d.dow}</div>
                  <div className="m">{d.label}</div>
                </div>
              ))}
              {calendar.hours.map((h) => (
                <CalRow key={h} hour={h} calendar={calendar} onOpen={setOpen} />
              ))}
            </div>
          </div>
          {calendar.events.length === 0 && (
            <div className="bw-empty">No bookings this week. They'll appear here as customers book.</div>
          )}
        </div>

        <div className="bw-rail-row">
        <div className="bw-card bw-pad">
          <div className="rt">Reliability status</div>
          <div className="bw-checks">
          <div className="bw-check">
            <div className="dot">&#10003;</div>
            <div>
              <div className="t">No double-bookings</div>
              <div className="s">Enforced in the database on every plan, including Free.</div>
            </div>
          </div>
          <div className="bw-check">
            <div className="dot">&#10003;</div>
            <div>
              <div className="t">POS matches storefront</div>
              <div className="s">Both read the same bookings, so a slot can't be open in one and taken in the other.</div>
            </div>
          </div>
          <div className="bw-check">
            <div className="dot">&#10003;</div>
            <div>
              <div className="t">Billing reconciled</div>
              <div className="s">
                {reconciliation
                  ? `Last audit ${new Date(reconciliation.ranAt).toLocaleDateString()} · ${reconciliation.mismatches} mismatch(es)`
                  : plan === "free"
                    ? "Runs weekly once a paid plan is active."
                    : "Runs weekly in the background; no audit yet."}
              </div>
            </div>
          </div>
          <div className="bw-check">
            <div className="dot">&#10003;</div>
            <div>
              <div className="t">Widget scoped to bookable items</div>
              <div className="s">No script runs on products that aren't services.</div>
            </div>
          </div>

          </div>
        </div>
        <div className="bw-card bw-pad">
          <div className="rt">Quick settings</div>
          <div className="bw-toggle">
            <div>
              <div className="t">Double-booking protection</div>
              <div className="s">Can't be turned off</div>
            </div>
            <div className="bw-switch on" aria-label="Always on">
              <div className="knob" />
            </div>
          </div>
          <div className="bw-toggle">
            <div>
              <div className="t">SMS reminders</div>
              <div className="s">Settings → Email &amp; SMS</div>
            </div>
            <div className={`bw-switch${toggles.sms ? " on" : ""}`}>
              <div className="knob" />
            </div>
          </div>
          <div className="bw-toggle">
            <div>
              <div className="t">Google Calendar sync</div>
              <div className="s">Integrations</div>
            </div>
            <div className={`bw-switch${toggles.sync ? " on" : ""}`}>
              <div className="knob" />
            </div>
          </div>
          <Link to={link("/app/settings")} className="bw-link">
            Change in Settings &rarr;
          </Link>
        </div>
        </div>
      </div>

      {open && (
        <div className="bw-overlay" onClick={() => setOpen(null)}>
          <div className="bw-popcard" onClick={(e) => e.stopPropagation()}>
            <h3>{open.service}</h3>
            <div className="row">
              <span>Customer</span>
              <b>{open.customer}</b>
            </div>
            <div className="row">
              <span>Email</span>
              <b>{open.email}</b>
            </div>
            <div className="row">
              <span>Staff</span>
              <b>{open.staff}</b>
            </div>
            <div className="row">
              <span>Time</span>
              <b>{open.full}</b>
            </div>
            <Link to={link("/app/bookings")} className="bw-link" style={{ display: "inline-block", marginTop: 10 }}>
              Manage in Bookings &rarr;
            </Link>
            <button type="button" className="close" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CalRow({
  hour,
  calendar,
  onOpen,
}: {
  hour: number;
  calendar: { days: { date: string }[]; events: { id: string; day: number; minute: number; tone: string; service: string; customer: string; time: string }[] };
  onOpen: (e: any) => void;
}) {
  return (
    <>
      <div className="timecell">{hourLabel(hour)}</div>
      {calendar.days.map((_, di) => (
        <div className="slot" key={di}>
          {calendar.events
            .filter((e) => e.day === di && Math.floor(e.minute / 60) === hour)
            .map((e) => (
              <button type="button" key={e.id} className={`bw-booking ${e.tone}`} onClick={() => onOpen(e)}>
                {e.service}
                <small>
                  {e.customer} · {e.time}
                </small>
              </button>
            ))}
        </div>
      ))}
    </>
  );
}
