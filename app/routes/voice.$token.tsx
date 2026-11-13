import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { twimlBye, twimlGather, validTwilioSignature, voiceAvailable, voiceSecret, voiceTurn } from "../models/voice.server";

const appUrl = () => (process.env.SHOPIFY_APP_URL || process.env.HOST || "").replace(/\/$/, "");
const twiml = (body: string) => new Response(body, { headers: { "Content-Type": "text/xml; charset=utf-8" } });

// Twilio Voice webhook: <app url>/voice/<token>. Set it as "A call comes in"
// (HTTP POST) on the merchant's Twilio phone number. The same URL with
// ?step=turn receives each spoken reply.
export async function action({ request, params }: ActionFunctionArgs) {
  const shop = await prisma.shop.findUnique({ where: { voiceToken: params.token || "" } });
  if (!shop || !shop.voiceEnabled) return twiml(twimlBye("Sorry, this line isn't taking bookings right now. Goodbye."));

  const form = await request.formData();
  const p: Record<string, string> = {};
  form.forEach((v, k) => (p[k] = String(v)));
  const url = new URL(request.url);
  const publicUrl = `${appUrl()}${url.pathname}${url.search}`;
  const secret = voiceSecret(shop);
  if (!secret || !validTwilioSignature(secret, publicUrl, p, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  if (!voiceAvailable()) return twiml(twimlBye("Sorry, the booking assistant isn't set up yet. Please call back later."));

  const turnUrl = `${appUrl()}/voice/${shop.voiceToken}?step=turn`;
  const lang = shop.defaultLanguage === "es" ? "es-US" : shop.defaultLanguage === "fr" ? "fr-FR" : shop.defaultLanguage === "de" ? "de-DE" : "en-US";

  if (url.searchParams.get("step") !== "turn") {
    await prisma.callSession.upsert({
      where: { callSid: p.CallSid },
      update: {},
      create: { shopId: shop.id, callSid: p.CallSid, caller: p.From || null },
    });
    const greeting = shop.voiceGreeting || "Hi, thanks for calling! I can help you book an appointment. What would you like to book?";
    return twiml(twimlGather(greeting, turnUrl, lang));
  }

  const session = await prisma.callSession.findUnique({ where: { callSid: p.CallSid } });
  if (!session) return twiml(twimlGather("Sorry, could you tell me again what you'd like to book?", turnUrl, lang));
  try {
    const { say, hangup } = await voiceTurn(shop, session, p.SpeechResult || "");
    return twiml(hangup ? twimlBye(say) : twimlGather(say, turnUrl, lang));
  } catch (e) {
    console.error("[bookwell] voice", e);
    return twiml(twimlGather("Sorry, I had a little trouble there. Could you say that again?", turnUrl, lang));
  }
}

export const loader = () => new Response("Twilio voice webhook: configure this URL with HTTP POST.", { status: 405 });
