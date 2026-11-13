import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { unbookableServices } from "./booking.server";

type Admin = { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> };

// Theme JSON files may start with a /* ... */ comment Shopify adds.
function parseThemeJson(content: string | undefined | null) {
  if (!content) return null;
  try {
    return JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ""));
  } catch {
    return null;
  }
}

/**
 * Is the booking block on the live theme's product template, and is the
 * floating-button app embed switched on? Reads the published theme's files
 * (needs read_themes); returns nulls when the theme can't be read.
 */
export async function themeInstallStatus(admin: Admin) {
  try {
    const res = await admin.graphql(`#graphql
      query BookwellTheme {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            name
            files(filenames: ["templates/product.json", "config/settings_data.json"], first: 2) {
              nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
            }
          }
        }
      }`);
    const data = await res.json();
    const theme = data?.data?.themes?.nodes?.[0];
    if (!theme) return { themeName: null, block: null as boolean | null, embed: null as boolean | null };
    const files = new Map<string, string>(
      (theme.files?.nodes ?? []).map((f: { filename: string; body?: { content?: string } }) => [f.filename, f.body?.content ?? ""]),
    );

    const product = parseThemeJson(files.get("templates/product.json"));
    let block = false;
    for (const section of Object.values<any>(product?.sections ?? {})) {
      for (const b of Object.values<any>(section?.blocks ?? {})) {
        if (typeof b?.type === "string" && b.type.includes("/blocks/booking/") && !b.disabled) block = true;
      }
    }

    const settings = parseThemeJson(files.get("config/settings_data.json"));
    let embed = false;
    for (const b of Object.values<any>(settings?.current?.blocks ?? {})) {
      if (typeof b?.type === "string" && b.type.includes("/blocks/embed/") && b.disabled !== true) embed = true;
    }
    return { themeName: theme.name as string, block, embed };
  } catch {
    return { themeName: null, block: null as boolean | null, embed: null as boolean | null };
  }
}

export async function onboardingState(shop: Shop, admin: Admin) {
  const [services, staff, unbookable, customerBookings, theme] = await Promise.all([
    prisma.service.findMany({
      where: { shopId: shop.id, archived: false },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, type: true, staffMode: true, productId: true, active: true },
    }),
    prisma.staffMember.findMany({
      where: { shopId: shop.id },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: { availability: true },
    }),
    unbookableServices(shop.id),
    prisma.booking.count({ where: { shopId: shop.id, source: { not: "manual" } } }),
    themeInstallStatus(admin),
  ]);

  const hasService = services.length > 0;
  const steps = {
    installed: true,
    service: hasService,
    availability: hasService && unbookable.length === 0 && services.some((s) => s.active),
    widget: Boolean(theme.block || theme.embed),
    testBooking: customerBookings > 0,
    finished: Boolean(shop.onboardingDoneAt),
  };
  return { services, staff, unbookable, theme, steps };
}

/** Count of completed setup steps (out of 5) for the nav badge / dashboard banner. */
export async function onboardingProgress(shop: Shop) {
  if (shop.onboardingDoneAt) return null;
  const [services, unbookable, bookings] = await Promise.all([
    prisma.service.count({ where: { shopId: shop.id, archived: false } }),
    unbookableServices(shop.id),
    prisma.booking.count({ where: { shopId: shop.id, source: { not: "manual" } } }),
  ]);
  return { done: 1 + (services ? 1 : 0) + (services && !unbookable.length ? 1 : 0) + (bookings ? 1 : 0), total: 6, hasService: services > 0 };
}
