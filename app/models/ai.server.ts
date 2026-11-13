import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

// "Create your service with AI": the merchant describes their business in
// their own words and Claude fills in a complete service configuration, which
// is saved as a paused draft for the merchant to review.
//
// Needs ANTHROPIC_API_KEY in the server environment.

const ServiceDraft = z.object({
  name: z.string().describe("Short customer-facing service name"),
  description: z.string().describe("1-3 sentences shown to customers on the booking page"),
  type: z.enum(["appointment", "group", "virtual", "event", "rental", "fullday", "multiday"]),
  durationMinutes: z.number().int().describe("Length of one booking in minutes (ignored for fullday/multiday)"),
  price: z.number().describe("Price per booking (per day for multiday), 0 if free or unknown"),
  bufferMinutes: z.number().int().describe("Cleanup/turnover gap after each booking, usually 0-30"),
  capacity: z.number().int().describe("Spots per time slot: 1 for private appointments, more for groups/rentals/events"),
  maxQuantity: z.number().int().describe("Most spots one customer may take in a booking"),
  staffMode: z.enum(["staff", "none"]).describe("staff if a person performs it (salon, coaching); none for rentals, events, tables, passes"),
  paymentMode: z.enum(["none", "full", "deposit_percent", "deposit_fixed"]),
  depositValue: z.number().describe("Deposit percent or fixed amount; 0 if no deposit"),
  minDays: z.number().int().describe("multiday only: minimum days, else 1"),
  maxDays: z.number().int().describe("multiday only: maximum days, else 14"),
  allowRecurring: z.boolean().describe("true for weekly classes/lessons people repeat"),
  waitlistEnabled: z.boolean(),
  openingHours: z
    .array(z.object({ weekday: z.number().int().describe("0=Sunday..6=Saturday"), start: z.string().describe("HH:MM"), end: z.string().describe("HH:MM") }))
    .describe("Used only when staffMode is none; typical opening hours for this kind of business"),
  addons: z.array(z.object({ name: z.string(), price: z.number(), durationMinutes: z.number().int() })).describe("0-4 sensible optional extras"),
  questions: z
    .array(
      z.object({
        label: z.string(),
        type: z.enum(["text", "textarea", "select", "checkbox"]),
        options: z.array(z.string()).describe("Only for select; otherwise empty"),
        required: z.boolean(),
      }),
    )
    .describe("0-4 booking-form questions this business would really need (name and email are always asked already)"),
});

export type ServiceDraft = z.infer<typeof ServiceDraft>;

export class AiUnavailableError extends Error {}

export function aiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const SYSTEM = `You set up booking services for Shopify merchants in an appointment-booking app.
From the merchant's description, produce one complete, realistic service configuration.
Use the merchant's own wording for names where possible. Use their prices and durations if given; otherwise pick typical values for that kind of business, and use 0 for price if you have no basis for one.
Choose the booking type carefully: appointment (one customer per slot with a person), group (classes/tours sharing a slot), virtual (online sessions), event (fixed-time tickets), rental (hourly courts/rooms/tables/equipment), fullday (day passes), multiday (stays or rentals over several days).
Only add deposits, add-ons and questions when they clearly fit the business.`;

export async function draftServiceFromDescription(description: string, currency: string): Promise<ServiceDraft> {
  if (!aiAvailable()) throw new AiUnavailableError("AI isn't set up: add ANTHROPIC_API_KEY to the app's environment.");
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      // Refusal safety net: if the model declines, the API retries on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(ServiceDraft) },
      system: SYSTEM,
      messages: [{ role: "user", content: `Store currency: ${currency}\n\nMerchant's description:\n${description}` }],
    });
    if (response.stop_reason === "refusal") throw new Error("The AI couldn't help with that description. Try rephrasing it.");
    if (!response.parsed_output) throw new Error("The AI's answer was incomplete. Please try again.");
    return response.parsed_output;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AiUnavailableError("The ANTHROPIC_API_KEY was rejected. Check the key.");
    if (e instanceof Anthropic.RateLimitError) throw new Error("The AI is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.APIError) throw new Error(`The AI request failed (${e.status ?? "network"}). Try again.`);
    throw e;
  }
}
