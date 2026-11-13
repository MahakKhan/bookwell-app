import { useEffect, useMemo, useRef, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { isDayService } from "../models/booking.server";
import { DATE_RE, formatInTz, localParts, zonedToUtc } from "../models/time.server";
import { addDays, weekdayOf, zonedNow } from "../dates";
import { Modal, STATUS_BADGE, STATUS_LABEL, money, useAppLink } from "../components/ui";

const VIEWS = [
  ["month", "Month"],
  ["week", "Week"],
  ["workweek", "Work week"],
  ["day", "Day"],
  ["agenda", "Agenda"],
] as const;
type View = (typeof VIEWS)[number][0];

function rangeFor(view: View, date: string, weekStartsOn: number) {
  const wd = weekdayOf(date);
  if (view === "day") return { from: date, to: date };
  if (view === "agenda") return { from: date, to: addDays(date, 30) };
  if (view === "workweek") {
    const monday = addDays(date, -((wd + 6) % 7));
    return { from: monday, to: addDays(monday, 4) };
  }
  if (view === "week") {
    const start = addDays(date, -((wd - weekStartsOn + 7) % 7));
    return { from: start, to: addDays(start, 6) };
  }
  const first = `${date.slice(0, 7)}-01`;
  const gridStart = addDays(first, -((weekdayOf(first) - weekStartsOn + 7) % 7));
  return { from: gridStart, to: addDays(gridStart, 41) };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const url = new URL(request.url);
  const tz = shop.timezone;
  const today = localParts(new Date(), tz).dateStr;
  const view = (VIEWS.some(([v]) => v === url.searchParams.get("view")) ? url.searchParams.get("view") : "week") as View;
  const date = DATE_RE.test(url.searchParams.get("date") || "") ? url.searchParams.get("date")! : today;
  const showCancelled = url.searchParams.get("cancelled") === "1";
  const { from, to } = rangeFor(view, date, shop.weekStartsOn);

  const [bookings, services, staff] = await Promise.all([
    prisma.booking.findMany({
      where: {
        shopId: shop.id,
        status: { in: showCancelled ? ["confirmed", "pending", "completed", "no_show", "cancelled"] : ["confirmed", "pending", "completed", "no_show"] },
        startsAt: { lt: zonedToUtc(addDays(to, 1), 0, tz) },
        endsAt: { gt: zonedToUtc(from, 0, tz) },
      },
      include: {
        service: { select: { name: true, color: true, type: true, bufferMinutes: true } },
        staff: { select: { name: true, color: true } },
      },
      orderBy: { startsAt: "asc" },
      take: 2000,
    }),
    prisma.service.findMany({ where: { shopId: shop.id, archived: false }, select: { id: true, name: true, color: true }, orderBy: { createdAt: "asc" } }),
    prisma.staffMember.findMany({ where: { shopId: shop.id }, select: { id: true, name: true, color: true, active: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
  ]);

  const time = (d: Date) => formatInTz(d, tz, { hour: "numeric", minute: "2-digit", hour12: !shop.use24h });
  return json({
    view,
    date,
    today,
    from,
    to,
    timezone: tz,
    currency: shop.currency,
    weekStartsOn: shop.weekStartsOn,
    use24h: shop.use24h,
    showCancelled,
    services,
    staff,
    events: bookings.map((b) => {
      const s = localParts(b.startsAt, tz);
      // endsAt includes the buffer; show the service's own end time.
      const realEnd = new Date(b.endsAt.getTime() - (isDayService(b.service) ? 1 : b.service.bufferMinutes) * 60_000);
      const e = localParts(realEnd, tz);
      return {
        id: b.id,
        serviceId: b.serviceId,
        staffId: b.staffId,
        title: b.service.name,
        customer: b.customerName,
        email: b.customerEmail,
        phone: b.customerPhone ?? "",
        staffName: b.staff?.name ?? "",
        quantity: b.quantity,
        status: b.status,
        total: Number(b.totalPrice),
        allDay: isDayService(b.service),
        startDate: s.dateStr,
        startMinute: s.minute,
        endDate: e.dateStr,
        endMinute: e.dateStr === s.dateStr ? Math.max(e.minute, s.minute + 15) : 24 * 60,
        timeLabel: isDayService(b.service) ? "All day" : `${time(b.startsAt)} – ${time(realEnd)}`,
        serviceColor: b.service.color,
        staffColor: b.staff?.color ?? b.service.color,
      };
    }),
  });
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Ev = Data["events"][number];

const HOUR_PX = 48;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function shortDate(d: string) {
  const [, m, day] = d.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${day}`;
}
function hourLabel(h: number, use24h: boolean) {
  if (use24h) return `${String(h).padStart(2, "0")}:00`;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}
function addMonths(d: string, n: number) {
  const [y, m] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return dt.toISOString().slice(0, 10);
}

export default function CalendarPage() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const link = useAppLink();
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(true);
  const [hiddenServices, setHiddenServices] = useState<string[]>([]);
  const [hiddenStaff, setHiddenStaff] = useState<string[]>([]);
  const [colorBy, setColorBy] = useState<"service" | "staff">("service");
  const [open, setOpen] = useState<Ev | null>(null);

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v === null ? p.delete(k) : p.set(k, v)));
    setParams(p, { preventScrollReset: true });
  };

  const events = useMemo(
    () => d.events.filter((e) => !hiddenServices.includes(e.serviceId) && !(e.staffId && hiddenStaff.includes(e.staffId))),
    [d.events, hiddenServices, hiddenStaff],
  );
  const colorOf = (e: Ev) => (colorBy === "staff" ? e.staffColor : e.serviceColor);

  const step = (dir: number) => {
    if (d.view === "month") return go({ date: addMonths(d.date, dir) });
    if (d.view === "day") return go({ date: addDays(d.date, dir) });
    if (d.view === "agenda") return go({ date: addDays(d.date, dir * 30) });
    return go({ date: addDays(d.date, dir * 7) });
  };

  const [y, m] = d.date.split("-").map(Number);
  const title =
    d.view === "month"
      ? `${MONTHS[m - 1]} ${y}`
      : d.view === "day"
        ? `${DOW[weekdayOf(d.date)]}, ${shortDate(d.date)}`
        : `${shortDate(d.from)} – ${shortDate(d.to)}`;

  return (
    <div>
      <div className="bw-head">
        <div>
          <h1>Calendar</h1>
          <p className="bw-sub">Times in store time ({d.timezone}).</p>
        </div>
        <div className="bw-row">
          <Link className="bw-btn" to={link("/app/settings")}>
            Calendar settings
          </Link>
          <button type="button" className="bw-btn" onClick={() => setShowFilters(!showFilters)}>
            {showFilters ? "Hide filters" : "Show filters"}
          </button>
          <button type="button" className="bw-btn dark" onClick={() => navigate(link("/app/bookings", { new: 1 }))}>
            Manual booking
          </button>
        </div>
      </div>

      <div className={`cal-layout${showFilters ? "" : " no-filters"}`}>
        {showFilters && (
          <aside className="bw-card cal-side">
            <MiniMonth d={d} onPick={(date) => go({ date })} />
            <div className="cal-filter-title">Filter by</div>
            <FilterGroup title="Services" items={d.services} hidden={hiddenServices} setHidden={setHiddenServices} />
            <FilterGroup title="Team members" items={d.staff} hidden={hiddenStaff} setHidden={setHiddenStaff} />
            <details className="cal-group" open>
              <summary>Event colours</summary>
              <label className="bw-check-row">
                <input type="radio" checked={colorBy === "service"} onChange={() => setColorBy("service")} /> Colour by service
              </label>
              <label className="bw-check-row">
                <input type="radio" checked={colorBy === "staff"} onChange={() => setColorBy("staff")} /> Colour by team member
              </label>
            </details>
            <details className="cal-group">
              <summary>Others</summary>
              <label className="bw-check-row">
                <input type="checkbox" checked={d.showCancelled} onChange={(e) => go({ cancelled: e.target.checked ? "1" : null })} /> Show cancelled bookings
              </label>
            </details>
          </aside>
        )}

        <section className="bw-card cal-main">
          <div className="cal-toolbar">
            <div className="cal-seg">
              <button type="button" onClick={() => go({ date: null })}>
                Today
              </button>
              <button type="button" onClick={() => step(-1)}>
                Back
              </button>
              <button type="button" onClick={() => step(1)}>
                Next
              </button>
            </div>
            <div className="cal-title">{title}</div>
            <div className="cal-seg">
              {VIEWS.map(([v, label]) => (
                <button key={v} type="button" className={d.view === v ? "on" : ""} onClick={() => go({ view: v })}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {d.view === "month" ? (
            <MonthGrid d={d} events={events} colorOf={colorOf} onOpen={setOpen} onDay={(date) => go({ view: "day", date })} />
          ) : d.view === "agenda" ? (
            <Agenda d={d} events={events} colorOf={colorOf} onOpen={setOpen} />
          ) : (
            <TimeGrid d={d} events={events} colorOf={colorOf} onOpen={setOpen} />
          )}
        </section>
      </div>

      {open && (
        <Modal title={open.title} onClose={() => setOpen(null)}>
          <dl className="bw-kv">
            <dt>When</dt>
            <dd>
              {open.startDate === open.endDate ? shortDate(open.startDate) : `${shortDate(open.startDate)} – ${shortDate(open.endDate)}`} · {open.timeLabel}
            </dd>
            <dt>Status</dt>
            <dd>
              <span className={`bw-badge ${STATUS_BADGE[open.status] ?? ""}`}>{STATUS_LABEL[open.status] ?? open.status}</span>
            </dd>
            <dt>Customer</dt>
            <dd>
              {open.customer} · {open.email}
              {open.phone ? ` · ${open.phone}` : ""}
            </dd>
            {open.staffName && (
              <>
                <dt>Team member</dt>
                <dd>{open.staffName}</dd>
              </>
            )}
            {open.quantity > 1 && (
              <>
                <dt>Spots</dt>
                <dd>{open.quantity}</dd>
              </>
            )}
            <dt>Price</dt>
            <dd>{open.total > 0 ? money(open.total, d.currency) : "Free"}</dd>
          </dl>
          <div className="bw-row">
            <Link className="bw-btn primary" to={link("/app/bookings", { q: open.email, tab: open.status === "cancelled" ? "cancelled" : null })}>
              Manage in Bookings
            </Link>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FilterGroup({
  title,
  items,
  hidden,
  setHidden,
}: {
  title: string;
  items: { id: string; name: string; color: string }[];
  hidden: string[];
  setHidden: (v: string[]) => void;
}) {
  return (
    <details className="cal-group">
      <summary>
        {title}
        {hidden.length ? <span className="bw-badge blue" style={{ marginLeft: 6 }}>{items.length - hidden.length}/{items.length}</span> : null}
      </summary>
      {items.length === 0 && <span className="bw-help">None yet</span>}
      {items.map((it) => (
        <label key={it.id} className="bw-check-row">
          <input
            type="checkbox"
            checked={!hidden.includes(it.id)}
            onChange={(e) => setHidden(e.target.checked ? hidden.filter((x) => x !== it.id) : [...hidden, it.id])}
          />
          <span className="bw-dot" style={{ background: it.color, marginTop: 4 }} />
          <span>{it.name}</span>
        </label>
      ))}
    </details>
  );
}

function MiniMonth({ d, onPick }: { d: Data; onPick: (date: string) => void }) {
  const [month, setMonth] = useState(`${d.date.slice(0, 7)}-01`);
  useEffect(() => setMonth(`${d.date.slice(0, 7)}-01`), [d.date]);
  const [y, m] = month.split("-").map(Number);
  const start = addDays(month, -((weekdayOf(month) - d.weekStartsOn + 7) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const heads = Array.from({ length: 7 }, (_, i) => DOW[(d.weekStartsOn + i) % 7].slice(0, 2));
  return (
    <div className="mini">
      <div className="mini-head">
        <button type="button" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
          ←
        </button>
        <b>
          {MONTHS[m - 1]} {y}
        </b>
        <button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
          →
        </button>
      </div>
      <div className="mini-grid">
        {heads.map((h) => (
          <span key={h} className="mini-dow">
            {h}
          </span>
        ))}
        {days.map((day) => (
          <button
            type="button"
            key={day}
            onClick={() => onPick(day)}
            className={`mini-day${day.slice(0, 7) !== month.slice(0, 7) ? " out" : ""}${day === d.today ? " today" : ""}${day === d.date ? " sel" : ""}`}
          >
            {Number(day.slice(8))}
          </button>
        ))}
      </div>
    </div>
  );
}

function EventChip({ e, color, onOpen, style }: { e: Ev; color: string; onOpen: (e: Ev) => void; style?: React.CSSProperties }) {
  return (
    <button
      type="button"
      className={`cal-ev${e.status === "cancelled" ? " cancelled" : ""}${e.status === "pending" ? " pending" : ""}`}
      style={{ ...style, background: `color-mix(in srgb, ${color} 16%, #fff)`, borderLeftColor: color, color: "var(--fg)" }}
      onClick={() => onOpen(e)}
      title={`${e.title} · ${e.customer} · ${e.timeLabel}`}
    >
      <b>{e.title}</b>
      <span>
        {e.timeLabel} · {e.customer}
      </span>
    </button>
  );
}

function TimeGrid({ d, events, colorOf, onOpen }: { d: Data; events: Ev[]; colorOf: (e: Ev) => string; onOpen: (e: Ev) => void }) {
  const days: string[] = [];
  for (let x = d.from; x <= d.to; x = addDays(x, 1)) days.push(x);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timed = events.filter((e) => !e.allDay && days.includes(e.startDate));
    const first = timed.length ? Math.min(...timed.map((e) => e.startMinute)) : 8 * 60;
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (Math.min(first, 8 * 60) / 60) * HOUR_PX - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.from, d.to]);

  const allDay = events.filter((e) => e.allDay || e.startDate !== e.endDate);
  const cols = `56px repeat(${days.length}, minmax(${days.length > 1 ? 90 : 200}px, 1fr))`;

  // Side-by-side lanes for overlapping bookings in a day.
  const lanesFor = (list: Ev[]) => {
    const sorted = [...list].sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute);
    const laneEnds: number[] = [];
    const placed = sorted.map((e) => {
      let lane = laneEnds.findIndex((end) => end <= e.startMinute);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(e.endMinute);
      } else laneEnds[lane] = e.endMinute;
      return { e, lane };
    });
    return { placed, lanes: Math.max(1, laneEnds.length) };
  };

  const now = new Date();
  const nowParts = zonedNow(d.timezone, now);

  return (
    <div className="cal-time">
      <div className="cal-time-head" style={{ gridTemplateColumns: cols }}>
        <div />
        {days.map((day) => (
          <div key={day} className={`cal-dayhead${day === d.today ? " today" : ""}`}>
            <span>{DOW[weekdayOf(day)]}</span> <b>{Number(day.slice(8))}</b>
          </div>
        ))}
      </div>
      {allDay.length > 0 && (
        <div className="cal-allday" style={{ gridTemplateColumns: cols }}>
          <div className="cal-allday-label">All day</div>
          {days.map((day) => (
            <div key={day} className="cal-allday-cell">
              {allDay
                .filter((e) => e.startDate <= day && e.endDate >= day)
                .map((e) => (
                  <EventChip key={e.id} e={e} color={colorOf(e)} onOpen={onOpen} />
                ))}
            </div>
          ))}
        </div>
      )}
      <div className="cal-scroll" ref={scroller}>
        <div className="cal-body" style={{ gridTemplateColumns: cols, height: 24 * HOUR_PX }}>
          <div className="cal-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} style={{ height: HOUR_PX }}>
                {h ? hourLabel(h, d.use24h) : ""}
              </div>
            ))}
          </div>
          {days.map((day) => {
            const { placed, lanes } = lanesFor(events.filter((e) => !e.allDay && e.startDate === day && e.endDate === day));
            return (
              <div key={day} className={`cal-col${day === d.today ? " today" : ""}`}>
                {day === nowParts.dateStr && <div className="cal-now" style={{ top: (nowParts.minute / 60) * HOUR_PX }} />}
                {placed.map(({ e, lane }) => (
                  <EventChip
                    key={e.id}
                    e={e}
                    color={colorOf(e)}
                    onOpen={onOpen}
                    style={{
                      position: "absolute",
                      top: (e.startMinute / 60) * HOUR_PX + 1,
                      height: Math.max(20, ((e.endMinute - e.startMinute) / 60) * HOUR_PX - 2),
                      left: `calc(${(lane / lanes) * 100}% + 2px)`,
                      width: `calc(${100 / lanes}% - 4px)`,
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({
  d,
  events,
  colorOf,
  onOpen,
  onDay,
}: {
  d: Data;
  events: Ev[];
  colorOf: (e: Ev) => string;
  onOpen: (e: Ev) => void;
  onDay: (date: string) => void;
}) {
  const days = Array.from({ length: 42 }, (_, i) => addDays(d.from, i));
  const month = d.date.slice(0, 7);
  return (
    <div className="cal-month">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="cal-month-dow">
          {DOW[(d.weekStartsOn + i) % 7]}
        </div>
      ))}
      {days.map((day) => {
        const list = events.filter((e) => e.startDate <= day && e.endDate >= day);
        return (
          <div key={day} className={`cal-month-cell${day.slice(0, 7) !== month ? " out" : ""}${day === d.today ? " today" : ""}`}>
            <button type="button" className="cal-month-num" onClick={() => onDay(day)}>
              {Number(day.slice(8))}
            </button>
            {list.slice(0, 3).map((e) => (
              <EventChip key={e.id} e={e} color={colorOf(e)} onOpen={onOpen} />
            ))}
            {list.length > 3 && (
              <button type="button" className="cal-more" onClick={() => onDay(day)}>
                +{list.length - 3} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Agenda({ d, events, colorOf, onOpen }: { d: Data; events: Ev[]; colorOf: (e: Ev) => string; onOpen: (e: Ev) => void }) {
  const byDay = new Map<string, Ev[]>();
  for (const e of events) byDay.set(e.startDate, [...(byDay.get(e.startDate) ?? []), e]);
  const days = [...byDay.keys()].sort();
  if (!days.length) return <div className="bw-empty-big"><div className="t">Nothing booked</div>No bookings in the next 30 days.</div>;
  return (
    <div className="cal-agenda">
      {days.map((day) => (
        <div key={day} className="cal-agenda-day">
          <div className={`cal-agenda-date${day === d.today ? " today" : ""}`}>
            <b>{Number(day.slice(8))}</b>
            <span>
              {DOW[weekdayOf(day)]}, {shortDate(day)}
            </span>
          </div>
          <div className="bw-stack" style={{ gap: 6, flex: 1 }}>
            {byDay.get(day)!.map((e) => (
              <EventChip key={e.id} e={e} color={colorOf(e)} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
