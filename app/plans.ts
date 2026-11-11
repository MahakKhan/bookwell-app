// Plan names double as the Shopify charge name shown to the merchant on
// the confirmation screen and as the key billing.check/request take, so
// keep these in sync with whatever copy the Settings/Billing page shows.
//
// Deliberately NOT in shopify.server.ts: that module is server-only, and
// app.billing.tsx's client-rendered component needs these same values
// (to compare against the active subscription's name) — importing them
// from a ".server" module there is a real client/server split violation,
// not just a lint nit.
export const PLAN_ENTRY = "Entry";
export const PLAN_GROWTH = "Growth";
