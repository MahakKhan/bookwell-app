import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { decrypt } from "./crypto.server";
import { getOpenSlots, isDayService, loadService } from "./booking.server";
import { SubmitError, submitBooking } from "./submit.server";
import { sendEmail, sendSms } from "./notify.server";
import { formatInTz, localParts } from "./time.server";
import { addDays } from "../dates";

// AI phone receptionist. Twilio answers the merchant's phone number, turns the
// caller's speech into text (<Gather input="speech">) and reads our replies
// aloud (<Say>). Each turn, Claude decides what to say and can call three
// tools that hit the real booking engine: list services, check open times,
// and book. It never invents availability.

export const voiceAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)). */
export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null) {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const VOICE = "Polly.Joanna-Neural";

export function twimlGather(say: string, actionUrl: string, lang = "en-US") {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${xml(actionUrl)}" method="POST" speechTimeout="auto" speechModel="phone_call" language="${lang}"><Say voice="${VOICE}">${xml(say)}</Say></Gather><Say voice="${VOICE}">Sorry, I didn't hear anything. Please call again any time. Goodbye.</Say><Hangup/></Response>`;
}
export function twimlBye(say: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE}">${xml(say)}</Say><Hangup/></Response>`;
}

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_services",
    description: "List the bookable services with their id, length and price. Call this before checking availability if you don't know the service id.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "check_availability",
    description: "Get open start times for a service on one date (store time). Only offer times returned here.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "Service id from list_services" },
        date: { type: "string", description: "Date as YYYY-MM-DD in the store's timezone" },
      },
      required: ["service_id", "date"],
      additionalProperties: false,
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a slot after the caller has confirmed the service, date, time and their name. starts_at must be one of the exact values returned by check_availability. Email is optional on the phone.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        starts_at: { type: "string", description: "Exact starts_at value from check_availability" },
        customer_name: { type: "string" },
        customer_email: { type: "string", description: "Empty string if the caller didn't give one" },
      },
      required: ["service_id", "starts_at", "customer_name", "customer_email"],
      additionalProperties: false,
    },
  },
  {
    name: "end_call",
    description: "End the call after saying goodbye. Use message to pass a note to the business (e.g. a callback request), or an empty string.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { goodbye: { type: "string", description: "Last sentence to say" }, message: { type: "string" } },
      required: ["goodbye", "message"],
      additionalProperties: false,
    },
  },
];

function systemPrompt(shop: Shop, services: { id: string; name: string }[]) {
  const now = new Date();
  const lp = localParts(now, shop.timezone);
  const today = formatInTz(now, shop.timezone, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `You are the friendly phone receptionist for ${shop.shopDomain.replace(".myshopify.com", "")}. You help callers book appointments.
Right now it is ${today} (store timezone ${shop.timezone}; today's date is ${lp.dateStr}, tomorrow is ${addDays(lp.dateStr, 1)}).
Services offered: ${services.map((s) => s.name).join(", ") || "none yet"}.

How to talk: you are on a phone call and everything you write is read aloud. Keep each reply to one or two short sentences, sound natural, never use lists, symbols, emojis or markdown. Say times like "two thirty in the afternoon" and dates like "Tuesday the 18th".
How to book: find out which service and which day, call check_availability, offer two or three of the returned times, then ask for the caller's full name. Before booking, repeat the service, day and time and ask them to confirm. Only then call book_appointment. Never make up times or prices; only use tool results. If a tool says something is unavailable, offer alternatives.
If the caller asks for something you can't do (a person, a refund, a complaint), offer to take a message and use end_call with the message. When the caller is done, say goodbye with end_call.
${shop.voiceInstructions ? `Extra instructions from the business: ${shop.voiceInstructions}` : ""}`;
}

type Msg = Anthropic.Beta.BetaMessageParam;

async function runTool(shop: Shop, caller: string | null, name: string, input: any, sessionId: string): Promise<string> {
  if (name === "list_services") {
    const list = await prisma.service.findMany({
      where: { shopId: shop.id, active: true, archived: false },
      select: { id: true, name: true, durationMinutes: true, price: true, type: true, paymentMode: true },
    });
    return JSON.stringify(
      list.map((s) => ({
        id: s.id,
        name: s.name,
        minutes: isDayService(s) ? "full day" : s.durationMinutes,
        price: Number(s.price),
        currency: shop.currency,
        prepayment: s.paymentMode !== "none",
      })),
    );
  }
  if (name === "check_availability") {
    const service = await loadService(shop.id, String(input.service_id || ""));
    if (!service || !service.active) return JSON.stringify({ error: "Unknown service id. Call list_services." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date))) return JSON.stringify({ error: "date must be YYYY-MM-DD" });
    const slots = (await getOpenSlots({ shop, service, staffId: "any", date: input.date })).filter((s) => s.available).slice(0, 12);
    return JSON.stringify({
      date: input.date,
      open_times: slots.map((s) => ({
        starts_at: s.startsAt.toISOString(),
        spoken: formatInTz(s.startsAt, shop.timezone, { hour: "numeric", minute: "2-digit", hour12: true }),
      })),
      note: slots.length ? undefined : "Nothing open that day.",
    });
  }
  if (name === "book_appointment") {
    const digits = (caller || "").replace(/\D/g, "") || "unknown";
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.customer_email || "")) ? String(input.customer_email) : `phone-${digits}@calls.bookwell.invalid`;
    try {
      const { bookings, checkoutUrl, service } = await submitBooking(
        shop,
        {
          serviceId: input.service_id,
          startsAt: input.starts_at,
          customerName: String(input.customer_name || "Phone caller"),
          customerEmail: email,
          customerPhone: caller || "",
          smsOptIn: true,
          notes: "Booked by the AI phone receptionist",
        },
        "api",
      );
      await prisma.callSession.update({ where: { id: sessionId }, data: { bookingId: bookings[0].id } });
      await prisma.booking.updateMany({ where: { id: { in: bookings.map((b) => b.id) } }, data: { source: "phone" } });
      if (checkoutUrl && caller) await sendSms(shop, caller, `To confirm your ${service.name} booking, complete payment here: ${checkoutUrl}`, "payment", bookings[0].id);
      return JSON.stringify({
        booked: true,
        when: formatInTz(bookings[0].startsAt, shop.timezone, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }),
        payment_link_sent_by_text: Boolean(checkoutUrl),
      });
    } catch (e) {
      if (e instanceof SubmitError) return JSON.stringify({ booked: false, error: e.message });
      throw e;
    }
  }
  if (name === "end_call") return JSON.stringify({ ok: true });
  return JSON.stringify({ error: "Unknown tool" });
}

/**
 * One caller turn: adds what they said, lets Claude reply (running tools as
 * needed), saves the conversation, and returns what to say and whether to
 * hang up.
 */
export async function voiceTurn(shop: Shop, session: { id: string; caller: string | null; messages: unknown }, said: string) {
  const services = await prisma.service.findMany({ where: { shopId: shop.id, active: true, archived: false }, select: { id: true, name: true } });
  const messages = (Array.isArray(session.messages) ? session.messages : []) as Msg[];
  messages.push({ role: "user", content: said || "(the caller said nothing)" });

  const client = new Anthropic({ timeout: 12_000, maxRetries: 0 });
  let say = "";
  let hangup = false;
  for (let i = 0; i < 5; i++) {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: systemPrompt(shop, services),
      tools: TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "refusal") {
      say = "Sorry, I can't help with that on the phone. Please contact the store directly. Goodbye.";
      hangup = true;
      break;
    }
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      say = text || "Sorry, could you say that again?";
      break;
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const c of calls) {
      let out: string;
      try {
        out = await runTool(shop, session.caller, c.name, c.input, session.id);
      } catch (e) {
        out = JSON.stringify({ error: (e as Error).message });
      }
      if (c.name === "end_call") {
        const input = c.input as { goodbye?: string; message?: string };
        say = [text, input.goodbye || "Thanks for calling. Goodbye."].filter(Boolean).join(" ");
        hangup = true;
        if (input.message && shop.notifyMerchantEmail) {
          void sendEmail(shop, shop.notifyMerchantEmail, "Phone message from your AI receptionist", `<p>Caller ${session.caller ?? "unknown"} left a message:</p><p>${input.message.replace(/</g, "&lt;")}</p>`, "merchant");
        }
      }
      results.push({ type: "tool_result", tool_use_id: c.id, content: out });
    }
    messages.push({ role: "user", content: results });
    if (hangup) break;
  }
  await prisma.callSession.update({ where: { id: session.id }, data: { messages: messages as any } });
  return { say: say || "Sorry, I didn't catch that. Could you repeat it?", hangup };
}

/** Readable transcript for the admin (what was said, no tool details). */
export function transcript(messages: unknown) {
  const out: { who: "caller" | "receptionist"; text: string }[] = [];
  for (const m of (Array.isArray(messages) ? messages : []) as Msg[]) {
    if (typeof m.content === "string") {
      if (m.role === "user") out.push({ who: "caller", text: m.content });
      continue;
    }
    for (const b of m.content as any[]) {
      if (b.type === "text" && m.role === "assistant" && b.text?.trim()) out.push({ who: "receptionist", text: b.text });
      if (b.type === "tool_use" && b.name === "end_call" && b.input?.goodbye) out.push({ who: "receptionist", text: b.input.goodbye });
    }
  }
  return out;
}

export function voiceSecret(shop: Shop) {
  return decrypt(shop.twilioAuthToken);
}
