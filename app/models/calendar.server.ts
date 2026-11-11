import prisma from "../db.server";
import type { Shop } from "@prisma/client";

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
async function getValidAccessToken(shop: Shop): Promise<string | null> {
  if (!shop.googleRefreshToken) return null;

  const stillValid =
    shop.googleAccessToken && shop.googleTokenExpiry && shop.googleTokenExpiry.getTime() - Date.now() > 60_000;
  if (stillValid) return shop.googleAccessToken;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: shop.googleRefreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { access_token: string; expires_in: number };
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      googleAccessToken: data.access_token,
      googleTokenExpiry: new Date(Date.now() + data.expires_in * 1000),
    },
  });
  return data.access_token;
}

export async function createGoogleCalendarEvent(
  shop: Shop,
  booking: { serviceName: string; staffName: string; customerName: string; startsAt: Date; endsAt: Date },
): Promise<string | null> {
  if (!shop.twoWaySyncOn) return null;
  const token = await getValidAccessToken(shop);
  if (!token) return null;

  try {
    const res = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(shop.googleCalendarId || "primary")}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: `${booking.serviceName} — ${booking.customerName}`,
        description: `Booked via Bookwell. Staff: ${booking.staffName}.`,
        start: { dateTime: booking.startsAt.toISOString() },
        end: { dateTime: booking.endsAt.toISOString() },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch {
    return null;
  }
}

export async function updateGoogleCalendarEvent(
  shop: Shop,
  googleEventId: string,
  booking: { startsAt: Date; endsAt: Date },
) {
  if (!shop.twoWaySyncOn) return;
  const token = await getValidAccessToken(shop);
  if (!token) return;

  try {
    await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(shop.googleCalendarId || "primary")}/events/${googleEventId}`,
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
  if (!shop.twoWaySyncOn) return;
  const token = await getValidAccessToken(shop);
  if (!token) return;

  try {
    await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(shop.googleCalendarId || "primary")}/events/${googleEventId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    // Non-fatal — the booking itself is already cancelled.
  }
}
