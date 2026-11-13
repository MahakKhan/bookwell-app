import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, Link, useLocation, useNavigation } from "@remix-run/react";

// Shopify identifies the store/session through these query params. Every
// internal link must keep them, or a full-page load loses the session.
const KEEP = ["shop", "host", "embedded", "locale"];

export function useAppLink() {
  const location = useLocation();
  const current = new URLSearchParams(location.search);
  return (path: string, extra?: Record<string, string | number | undefined | null>) => {
    const [pathname, query = ""] = path.split("?");
    const next = new URLSearchParams(query);
    KEEP.forEach((k) => {
      const v = current.get(k);
      if (v && !next.has(k)) next.set(k, v);
    });
    Object.entries(extra ?? {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") next.delete(k);
      else next.set(k, String(v));
    });
    const s = next.toString();
    return s ? `${pathname}?${s}` : pathname;
  };
}

const SERVICE_TABS: [string, string][] = [
  ["/app/services", "Services"],
  ["/app/packages", "Packages"],
  ["/app/equipment", "Equipment"],
  ["/app/waivers", "Waivers"],
];

/** Tab bar shared by the pages that live under "Services" in the sidebar. */
export function ServicesTabs() {
  const link = useAppLink();
  const { pathname } = useLocation();
  return (
    <div className="bw-tabs" role="tablist" aria-label="Services">
      {SERVICE_TABS.map(([path, label]) => (
        <Link key={path} to={link(path)} className={pathname.startsWith(path) ? "on" : ""} role="tab" aria-selected={pathname.startsWith(path)}>
          {label}
        </Link>
      ))}
    </div>
  );
}

export function useBusy() {
  const n = useNavigation();
  return n.state === "submitting";
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="bw-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`bw-modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="bw-modal-h">
          <h3>{title}</h3>
          <button type="button" className="bw-x" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="bw-modal-b">{children}</div>
        {footer && <div className="bw-modal-f">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Feedback for an action's `{ ok }`, `{ error }` or `{ warning }`.
 * Success shows as a Shopify toast (visible wherever you are on the page),
 * once the page has finished refreshing so the new data is already there.
 * Errors and warnings stay on the page and scroll into view.
 */
export function Flash({ data }: { data: unknown }) {
  const navigation = useNavigation();
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<unknown>(null);
  const toasted = useRef<unknown>(null);
  const toast = typeof window !== "undefined" ? (window as unknown as { shopify?: { toast?: { show: (m: string, o?: object) => void } } }).shopify?.toast : undefined;

  useEffect(() => {
    if (!data || typeof data !== "object") return;
    const d = data as { ok?: unknown };
    if (typeof d.ok === "string" && toast) {
      if (navigation.state !== "idle" || toasted.current === data) return;
      toasted.current = data;
      toast.show(d.ok, { duration: 4000 });
      setShown(null);
      return;
    }
    setShown(data);
  }, [data, navigation.state, toast]);

  useEffect(() => {
    if (shown) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (shown && typeof shown === "object" && "ok" in shown && !("error" in shown) && !("warning" in shown)) {
      const t = setTimeout(() => setShown(null), 6000);
      return () => clearTimeout(t);
    }
  }, [shown]);

  if (!shown || typeof shown !== "object") return null;
  const d = shown as { ok?: unknown; error?: unknown; warning?: unknown };
  return (
    <div ref={ref}>
      {d.error ? <div className="bw-alert err">{String(d.error)}</div> : null}
      {d.warning ? <div className="bw-alert warn">{String(d.warning)}</div> : null}
      {typeof d.ok === "string" ? <div className="bw-alert ok">{d.ok}</div> : null}
    </div>
  );
}

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const toTime = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Weekly hours as native inputs named on_<d>, start_<d>, end_<d>. */
export function HoursEditor({
  rules,
  defaultStart = 540,
  defaultEnd = 1020,
}: {
  rules: { weekday: number; startMinute: number; endMinute: number }[];
  defaultStart?: number;
  defaultEnd?: number;
}) {
  const byDay = new Map(rules.map((r) => [r.weekday, r]));
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="bw-hours">
      {order.map((d) => {
        const rule = byDay.get(d);
        return (
          <HoursRow key={d} d={d} rule={rule} defaultStart={defaultStart} defaultEnd={defaultEnd} />
        );
      })}
    </div>
  );
}

function HoursRow({
  d,
  rule,
  defaultStart,
  defaultEnd,
}: {
  d: number;
  rule?: { startMinute: number; endMinute: number };
  defaultStart: number;
  defaultEnd: number;
}) {
  const [on, setOn] = useState(Boolean(rule));
  return (
    <>
      <label className="bw-check-row" style={{ alignItems: "center" }}>
        <input type="checkbox" name={`on_${d}`} checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span className="t">{DAYS[d]}</span>
      </label>
      <input type="time" name={`start_${d}`} defaultValue={toTime(rule?.startMinute ?? defaultStart)} disabled={!on} />
      <span style={{ color: "var(--muted)" }}>to</span>
      <input
        type="time"
        name={`end_${d}`}
        defaultValue={toTime(Math.min(rule?.endMinute ?? defaultEnd, 1439))}
        disabled={!on}
      />
    </>
  );
}

type Block = {
  id: string;
  kind: string;
  startDate: string | null;
  endDate: string | null;
  weekday: number | null;
  startMinute: number | null;
  endMinute: number | null;
  label: string | null;
  source: string;
};

export function describeBlock(b: Block) {
  if (b.kind === "dates") {
    const range = b.endDate && b.endDate !== b.startDate ? `${b.startDate} → ${b.endDate}` : b.startDate;
    return range ?? "";
  }
  const when = b.startDate ? b.startDate : b.weekday != null ? `Every ${DAYS[b.weekday]}` : "Every day";
  return `${when}, ${toTime(b.startMinute ?? 0)}–${toTime(b.endMinute ?? 0)}`;
}

/**
 * Blocked dates + break times editor. Posts intents addBlock / deleteBlock
 * (handled by handleBlockIntent in blocks.server.ts) with an optional scope.
 */
export function BlocksEditor({
  blocks: rawBlocks,
  scope,
  showBreaks = true,
  showHolidays = false,
}: {
  blocks: unknown[];
  scope?: { name: "staffId" | "serviceId" | "resourceId"; value: string };
  showBreaks?: boolean;
  showHolidays?: boolean;
}) {
  const [kind, setKind] = useState<"dates" | "break" | null>(null);
  const busy = useBusy();
  const blocks = rawBlocks.filter(Boolean) as Block[];
  const dates = blocks.filter((b) => b.kind === "dates");
  const breaks = blocks.filter((b) => b.kind === "break");
  const hidden = scope ? <input type="hidden" name={scope.name} value={scope.value} /> : null;

  const list = (items: Block[], empty: string) =>
    items.length === 0 ? (
      <div className="bw-dashed">{empty}</div>
    ) : (
      <div className="bw-mini-list">
        {items.map((b) => (
          <div className="it" key={b.id}>
            <span>
              {describeBlock(b)}
              {b.label ? <span style={{ color: "var(--muted)" }}> · {b.label}</span> : null}
              {b.source === "holiday" ? <span className="bw-badge blue" style={{ marginLeft: 6 }}>Holiday</span> : null}
            </span>
            <Form method="post">
              <input type="hidden" name="intent" value="deleteBlock" />
              <input type="hidden" name="blockId" value={b.id} />
              <button className="bw-btn sm danger" type="submit">
                Remove
              </button>
            </Form>
          </div>
        ))}
      </div>
    );

  return (
    <div className="bw-stack">
      <div className="bw-alert warn" style={{ margin: 0 }}>
        Blocking dates doesn't affect bookings already made; it only stops new ones.
      </div>
      <div className="bw-row between">
        <span className="bw-label">Blocked dates</span>
        <button type="button" className="bw-btn sm" onClick={() => setKind("dates")}>
          + Add blocked dates
        </button>
      </div>
      {list(dates, "No blocked dates")}
      {showBreaks && (
        <>
          <div className="bw-row between">
            <span className="bw-label">Break times</span>
            <button type="button" className="bw-btn sm" onClick={() => setKind("break")}>
              + Add break
            </button>
          </div>
          {list(breaks, "No break times")}
        </>
      )}
      {showHolidays && (
        <Form method="post" className="bw-row">
          <input type="hidden" name="intent" value="importHolidays" />
          {hidden}
          <select name="country" className="bw-select auto" defaultValue="US">
            {HOLIDAY_COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          <select name="year" className="bw-select auto" defaultValue={String(new Date().getFullYear())}>
            {[0, 1].map((i) => (
              <option key={i} value={new Date().getFullYear() + i}>
                {new Date().getFullYear() + i}
              </option>
            ))}
          </select>
          <button className="bw-btn sm" type="submit" disabled={busy}>
            Import public holidays
          </button>
        </Form>
      )}

      {kind && (
        <Modal title={kind === "dates" ? "Block dates" : "Add a break"} onClose={() => setKind(null)}>
          <Form method="post" className="bw-stack" onSubmit={() => setTimeout(() => setKind(null), 50)}>
            <input type="hidden" name="intent" value="addBlock" />
            <input type="hidden" name="kind" value={kind} />
            {hidden}
            {kind === "dates" ? (
              <div className="bw-grid">
                <div className="bw-field">
                  <label>From</label>
                  <input type="date" name="startDate" className="bw-input" required />
                </div>
                <div className="bw-field">
                  <label>To (optional)</label>
                  <input type="date" name="endDate" className="bw-input" />
                </div>
              </div>
            ) : (
              <>
                <div className="bw-field">
                  <label>Repeats</label>
                  <select name="weekday" className="bw-select" defaultValue="all">
                    <option value="all">Every day</option>
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>
                        Every {d}
                      </option>
                    ))}
                    <option value="date">On one date only</option>
                  </select>
                </div>
                <div className="bw-field">
                  <label>Date (only for "one date only")</label>
                  <input type="date" name="startDate" className="bw-input" />
                </div>
                <div className="bw-grid">
                  <div className="bw-field">
                    <label>From</label>
                    <input type="time" name="startTime" className="bw-input" defaultValue="12:00" required />
                  </div>
                  <div className="bw-field">
                    <label>To</label>
                    <input type="time" name="endTime" className="bw-input" defaultValue="13:00" required />
                  </div>
                </div>
              </>
            )}
            <div className="bw-field">
              <label>Label (optional)</label>
              <input name="label" className="bw-input" placeholder={kind === "dates" ? "e.g. Christmas" : "e.g. Lunch"} />
            </div>
            <div className="bw-row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="bw-btn" onClick={() => setKind(null)}>
                Cancel
              </button>
              <button type="submit" className="bw-btn primary">
                Save
              </button>
            </div>
          </Form>
        </Modal>
      )}
    </div>
  );
}

export const HOLIDAY_COUNTRIES: [string, string][] = [
  ["US", "United States"],
  ["GB", "United Kingdom"],
  ["CA", "Canada"],
  ["AU", "Australia"],
  ["NZ", "New Zealand"],
  ["IE", "Ireland"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["ES", "Spain"],
  ["IT", "Italy"],
  ["NL", "Netherlands"],
  ["BE", "Belgium"],
  ["CH", "Switzerland"],
  ["AT", "Austria"],
  ["SE", "Sweden"],
  ["NO", "Norway"],
  ["DK", "Denmark"],
  ["FI", "Finland"],
  ["PL", "Poland"],
  ["PT", "Portugal"],
  ["BR", "Brazil"],
  ["MX", "Mexico"],
  ["AR", "Argentina"],
  ["ZA", "South Africa"],
  ["JP", "Japan"],
  ["KR", "South Korea"],
  ["SG", "Singapore"],
  ["IN", "India"],
  ["PK", "Pakistan"],
  ["AE", "United Arab Emirates"],
];

export function money(n: number, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

export const STATUS_BADGE: Record<string, string> = {
  confirmed: "green",
  completed: "blue",
  pending: "amber",
  cancelled: "red",
  abandoned: "",
  no_show: "red",
};

export const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  completed: "Completed",
  pending: "Awaiting payment",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
  no_show: "No-show",
};

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export type Question = { id?: string; label: string; type: string; options: string; required: boolean };

export function QuestionRow({ q, onChange, onRemove }: { q: Question; onChange: (q: Question) => void; onRemove: () => void }) {
  return (
    <div className="bw-row" style={{ alignItems: "flex-start" }}>
      <input className="bw-input" style={{ flex: "3 1 200px" }} placeholder="Question" value={q.label} onChange={(e) => onChange({ ...q, label: e.target.value })} />
      <select className="bw-select" style={{ flex: "1 1 120px" }} value={q.type} onChange={(e) => onChange({ ...q, type: e.target.value })}>
        <option value="text">Short text</option>
        <option value="textarea">Long text</option>
        <option value="select">Dropdown</option>
        <option value="checkbox">Checkbox</option>
      </select>
      {q.type === "select" && (
        <input className="bw-input" style={{ flex: "2 1 160px" }} placeholder="Options, comma separated" value={q.options} onChange={(e) => onChange({ ...q, options: e.target.value })} />
      )}
      <label className="bw-check-row" style={{ alignItems: "center", paddingTop: 8 }}>
        <input type="checkbox" checked={q.required} onChange={(e) => onChange({ ...q, required: e.target.checked })} /> Required
      </label>
      <button type="button" className="bw-btn sm danger" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}
