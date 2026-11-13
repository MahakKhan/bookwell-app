import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { decrypt, encrypt } from "./crypto.server";

// Outlook Calendar + Microsoft Teams through Microsoft Graph. Needs the app's
// own Azure app registration (MS_CLIENT_ID / MS_CLIENT_SECRET env) with the
// redirect URI <app url>/oauth/microsoft/callback and delegated permissions
// offline_access, User.Read, Calendars.ReadWrite. Teams links need a work or
// school Microsoft 365 account. Every call no-ops when not connected.

const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access User.Read Calendars.ReadWrite";

export const microsoftConfigured = () => Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

export function microsoftOAuthUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES,
    state,
    prompt: "select_account",
  });
  return `${AUTH}/authorize?${q}`;
}

type Tokens = { access_token: string; refresh_token?: string; expires_in: number };

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID || "", client_secret: process.env.MS_CLIENT_SECRET || "", scope: SCOPES, ...body }),
  });
  if (!res.ok) throw new Error(`Microsoft token request failed: ${await res.text()}`);
  return res.json() as Promise<Tokens>;
}

export async function connectMicrosoft(shopId: string, code: string, redirectUri: string) {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  let account: string | null = null;
  try {
    const me = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    const j = (await me.json()) as { mail?: string; userPrincipalName?: string };
    account = j.mail || j.userPrincipalName || null;
  } catch {
    // optional
  }
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      msAccessToken: encrypt(t.access_token),
      msRefreshToken: t.refresh_token ? encrypt(t.refresh_token) : undefined,
      msTokenExpiry: new Date(Date.now() + t.expires_in * 1000),
      msAccount: account,
      outlookSyncOn: true,
    },
  });
}

async function accessToken(shop: Shop): Promise<string | null> {
  const fresh = await prisma.shop.findUnique({ where: { id: shop.id } });
  const refresh = decrypt(fresh?.msRefreshToken);
  if (!fresh || !refresh || !microsoftConfigured()) return null;
  const cached = decrypt(fresh.msAccessToken);
  if (cached && fresh.msTokenExpiry && fresh.msTokenExpiry.getTime() - Date.now() > 60_000) return cached;
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        msAccessToken: encrypt(t.access_token),
        ...(t.refresh_token ? { msRefreshToken: encrypt(t.refresh_token) } : {}),
        msTokenExpiry: new Date(Date.now() + t.expires_in * 1000),
      },
    });
    return t.access_token;
  } catch {
    return null;
  }
}

const utc = (d: Date) => ({ dateTime: d.toISOString().replace("Z", ""), timeZone: "UTC" });

/** Creates the Outlook event; with `teams` Graph attaches a Teams meeting and returns its join link. */
export async function createOutlookEvent(
  shop: Shop,
  b: { title: string; description: string; startsAt: Date; endsAt: Date },
  opts: { teams?: boolean } = {},
): Promise<{ id: string | null; joinUrl: string | null }> {
  if (!shop.outlookSyncOn && !opts.teams) return { id: null, joinUrl: null };
  const token = await accessToken(shop);
  if (!token) return { id: null, joinUrl: null };
  try {
    const res = await fetch(`${GRAPH}/me/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: b.title,
        body: { contentType: "text", content: b.description },
        start: utc(b.startsAt),
        end: utc(b.endsAt),
        ...(opts.teams ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
      }),
    });
    if (!res.ok) return { id: null, joinUrl: null };
    const e = (await res.json()) as { id: string; onlineMeeting?: { joinUrl?: string } };
    return { id: e.id, joinUrl: e.onlineMeeting?.joinUrl ?? null };
  } catch {
    return { id: null, joinUrl: null };
  }
}

export async function updateOutlookEvent(shop: Shop, eventId: string, b: { startsAt: Date; endsAt: Date }) {
  const token = await accessToken(shop);
  if (!token) return;
  await fetch(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ start: utc(b.startsAt), end: utc(b.endsAt) }),
  }).catch(() => {});
}

export async function deleteOutlookEvent(shop: Shop, eventId: string) {
  const token = await accessToken(shop);
  if (!token) return;
  await fetch(`${GRAPH}/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

/** Two-way sync: busy Outlook events (not Bookwell's own) block those times. */
export async function syncOutlookBusy(shop: Shop) {
  if (!shop.outlookBlockBusy) return 0;
  const token = await accessToken(shop);
  if (!token) return 0;
  const from = new Date();
  const to = new Date(Date.now() + 120 * 86_400_000);
  const ours = new Set(
    (await prisma.booking.findMany({ where: { shopId: shop.id, outlookEventId: { not: null }, endsAt: { gt: from } }, select: { outlookEventId: true } })).map(
      (b) => b.outlookEventId,
    ),
  );
  const busy: { startsAt: Date; endsAt: Date }[] = [];
  let url: string | null =
    `${GRAPH}/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$select=id,showAs,isCancelled,start,end&$top=200`;
  for (let page = 0; url && page < 15; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
    if (!res.ok) return 0;
    const data = (await res.json()) as {
      value?: { id: string; showAs?: string; isCancelled?: boolean; start: { dateTime: string }; end: { dateTime: string } }[];
      "@odata.nextLink"?: string;
    };
    for (const ev of data.value ?? []) {
      if (ev.isCancelled || ev.showAs === "free" || ours.has(ev.id)) continue;
      busy.push({ startsAt: new Date(`${ev.start.dateTime.replace(/Z?$/, "")}Z`), endsAt: new Date(`${ev.end.dateTime.replace(/Z?$/, "")}Z`) });
    }
    url = data["@odata.nextLink"] ?? null;
  }
  await prisma.$transaction([
    prisma.externalBusy.deleteMany({ where: { shopId: shop.id, source: "outlook" } }),
    prisma.externalBusy.createMany({ data: busy.map((b) => ({ ...b, shopId: shop.id, source: "outlook" })) }),
  ]);
  return busy.length;
}
