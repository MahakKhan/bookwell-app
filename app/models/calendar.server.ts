import prisma from "../db.server";
import type { Shop } from "@prisma/client";
import { decrypt, encrypt } from "./crypto.server";
import { zonedToUtc } from "./time.server";

const syncActive = (shop: Shop) => shop.twoWaySyncOn;

// Google Calendar two-way sync via plain REST calls (no googleapis SDK
// dependency). Requires the developer's own OAuth app: GOOGLE_CLIENT_ID
// and GOOGLE_CLIENT_SECRET env vars, created in Google Cloud Console —
// see app/routes/app.calendar.connect.tsx for the redirect URI to
// register there. A shop with no googleRefreshToken is simply not
// connected; every function below no-ops rather than throwing, same
// pattern as notify.server.ts.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export function googleOAuthUrl(redirectUri: string, state: string) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/calendar.events",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}

// Returns a valid access token, refreshing it first if it's expired.
// Persists the refreshed token so the next call doesn't refresh again.
export async function getValidAccessToken(shop: Shop): Promise<string | null> {
  const refreshToken = decrypt(shop.googleRefreshToken);
  if (!refreshToken) return null;

  const cachedAccess = decrypt(shop.googleAccessToken);
  const stillValid =
    cachedAccess && shop.googleTokenExpiry && shop.googleTokenExpiry.getTime() - Date.now() > 60_000;
  if (stillValid) return cachedAccess;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { access_token: string; expires_in: number };
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      googleAccessToken: encrypt(data.access_token),
      googleTokenExpiry: new Date(Date.now() + data.expires_in * 1000),
    },
  });
  return data.access_token;
}

export async function createGoogleCalendarEvent(
  shop: Shop,
  booking: { serviceName: string; staffName: string; customerName: string; startsAt: Date; endsAt: Date },
): Promise<string | null> {
  return (await createGoogleCalendarEventFull(shop, booking)).id;
}

/**
 * Creates the calendar event; with `meet` it also asks Google to attach a
 * Google Meet conference and returns its join link. A Meet link works even
 * when calendar sync itself is off, as long as Google is connected.
 */
export async function createGoogleCalendarEventFull(
  shop: Shop,
  booking: { serviceName: string; staffName: string; customerName: string; startsAt: Date; endsAt: Date; bookingId?: string },
  opts: { meet?: boolean } = {},
): Promise<{ id: string | null; meetUrl: string | null }> {
  if (!syncActive(shop) && !opts.meet) return { id: null, meetUrl: null };
  const token = await getValidAccessToken(shop);
  if (!token) return { id: null, meetUrl: null };

  try {
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(shop.googleCalendarId || "primary")}/events${opts.meet ? "?conferenceDataVersion=1" : ""}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: `${booking.serviceName} — ${booking.customerName}`,
          description: `Booked via Bookwell.${booking.staffName ? ` Staff: ${booking.staffName}.` : ""}`,
          start: { dateTime: booking.startsAt.toISOString() },
          end: { dateTime: booking.endsAt.toISOString() },
          ...(opts.meet
            ? {
                conferenceData: {
                  createRequest: { requestId: `bw-${booking.bookingId ?? Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
                },
              }
            : {}),
        }),
      },
    );
    if (!res.ok) return { id: null, meetUrl: null };
    const data = (await res.json()) as { id: string; hangoutLink?: string };
    return { id: data.id, meetUrl: data.hangoutLink ?? null };
  } catch {
    return { id: null, meetUrl: null };
  }
}

/**
 * Two-way sync: copies busy events from the connected Google Calendar into
 * ExternalBusy so the booking engine treats them as blocked. Events Bookwell
 * created itself, free ("transparent") events and cancelled ones are skipped.
 */
export async function syncGoogleBusy(shop: Shop) {
  if (!shop.googleBlockBusy) return 0;
  const token = await getValidAccessToken(shop);
  if (!token) return 0;
  const timeMin = new Date();
  const timeMax = new Date(Date.now() + 120 * 86_400_000);
  const ours = new Set(
    (
      await prisma.booking.findMany({
        where: { shopId: shop.id, googleEventId: { not: null }, endsAt: { gt: timeMin } },
        select: { googleEventId: true },
      })
    ).map((b) => b.googleEventId),
  );

  const busy: { startsAt: Date; endsAt: Date }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(shop.googleCalendarId || "primary")}/events?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as {
      items?: { id: string; status?: string; transparency?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
      nextPageToken?: string;
    };
    for (const ev of data.items ?? []) {
      if (ev.status === "cancelled" || ev.transparency === "transparent" || ours.has(ev.id)) continue;
      if (ev.start?.dateTime && ev.end?.dateTime) {
        busy.push({ startsAt: new Date(ev.start.dateTime), endsAt: new Date(ev.end.dateTime) });
      } else if (ev.start?.date && ev.end?.date) {
        // All-day event: block those whole days in the shop timezone.
        busy.push({ startsAt: zonedToUtc(ev.start.date, 0, shop.timezone), endsAt: zonedToUtc(ev.end.date, 0, shop.timezone) });
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  await prisma.$transaction([
    prisma.externalBusy.deleteMany({ where: { shopId: shop.id, source: "google" } }),
    prisma.externalBusy.createMany({ data: busy.map((b) => ({ ...b, shopId: shop.id })) }),
  ]);
  return busy.length;
}

export async function updateGoogleCalendarEvent(
  shop: Shop,
  googleEventId: string,
  booking: { startsAt: Date; endsAt: Date },
) {
  if (!syncActive(shop)) return;
  const token = await getValidAccessToken(shop);
  if (!token) return;

  try {
    await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(shop.googleCalendarId || "primary")}/events/${encodeURIComponent(googleEventId)}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          start: { dateTime: booking.startsAt.toISOString() },
          end: { dateTime: booking.endsAt.toISOString() },
        }),
      },
    );
  } catch {
    // Non-fatal — the booking itself already moved.
  }
}

export async function deleteGoogleCalendarEvent(shop: Shop, googleEventId: string) {
  if (!syncActive(shop)) return;
  const token = await getValidAccessToken(shop);
  if (!token) return;

  try {
    await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(shop.googleCalendarId || "primary")}/events/${encodeURIComponent(googleEventId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    // Non-fatal — the booking itself is already cancelled.
  }
}
