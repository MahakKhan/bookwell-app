import prisma from "../db.server";
import { DATE_RE } from "./time.server";

export function parseTime(v: FormDataEntryValue | null): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
}

/** Reads on_<d>/start_<d>/end_<d> fields into availability rules. */
export function parseHours(form: FormData) {
  const rules: { weekday: number; startMinute: number; endMinute: number }[] = [];
  for (let d = 0; d < 7; d++) {
    if (form.get(`on_${d}`) !== "on") continue;
    const start = parseTime(form.get(`start_${d}`));
    let end = parseTime(form.get(`end_${d}`));
    if (end === 23 * 60 + 59) end = 24 * 60; // "23:59" means until midnight
    if (start === null || end === null || start >= end) {
      throw new Error("Each open day needs an end time after its start time.");
    }
    rules.push({ weekday: d, startMinute: start, endMinute: end });
  }
  return rules;
}

type Scope = { staffId?: string; serviceId?: string; resourceId?: string };

/**
 * Shared handler for the BlocksEditor intents. Returns a JSON-able result, or
 * null when the intent isn't a block intent.
 */
export async function handleBlockIntent(shopId: string, form: FormData, scope: Scope = {}) {
  const intent = String(form.get("intent") || "");

  if (intent === "deleteBlock") {
    await prisma.blockedTime.deleteMany({ where: { id: String(form.get("blockId") || ""), shopId } });
    return { ok: "Removed." };
  }

  if (intent === "addBlock") {
    const kind = String(form.get("kind")) === "break" ? "break" : "dates";
    const label = String(form.get("label") || "").trim().slice(0, 80) || null;
    if (kind === "dates") {
      const startDate = String(form.get("startDate") || "");
      const endDate = String(form.get("endDate") || "") || startDate;
      if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || endDate < startDate) {
        return { error: "Pick a valid date range." };
      }
      await prisma.blockedTime.create({ data: { shopId, ...scope, kind, startDate, endDate, label } });
      return { ok: "Dates blocked." };
    }
    const startMinute = parseTime(form.get("startTime"));
    const endMinute = parseTime(form.get("endTime"));
    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
      return { error: "The break must end after it starts." };
    }
    const repeat = String(form.get("weekday") || "all");
    const date = String(form.get("startDate") || "");
    if (repeat === "date" && !DATE_RE.test(date)) return { error: "Pick the date for this break." };
    await prisma.blockedTime.create({
      data: {
        shopId,
        ...scope,
        kind,
        label,
        startMinute,
        endMinute,
        weekday: repeat !== "all" && repeat !== "date" ? Number(repeat) : null,
        startDate: repeat === "date" ? date : null,
      },
    });
    return { ok: "Break added." };
  }

  if (intent === "importHolidays") {
    const country = String(form.get("country") || "").toUpperCase();
    const year = Number(form.get("year"));
    if (!/^[A-Z]{2}$/.test(country) || !(year >= 2000 && year <= 2100)) return { error: "Pick a country and year." };
    try {
      // Public holiday data (country code + year only; no store data is sent).
      const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { error: "Couldn't load holidays for that country." };
      const list = (await res.json()) as { date: string; localName: string; name: string; global?: boolean }[];
      const existing = new Set(
        (
          await prisma.blockedTime.findMany({
            where: { shopId, source: "holiday", ...scope },
            select: { startDate: true },
          })
        ).map((b) => b.startDate),
      );
      const rows = list
        .filter((h) => h.global !== false && DATE_RE.test(h.date) && !existing.has(h.date))
        .map((h) => ({ shopId, ...scope, kind: "dates", startDate: h.date, endDate: h.date, label: h.name, source: "holiday" }));
      if (rows.length) await prisma.blockedTime.createMany({ data: rows });
      return { ok: `Imported ${rows.length} public holiday(s).` };
    } catch {
      return { error: "Couldn't reach the holiday service. Try again later." };
    }
  }

  return null;
}
