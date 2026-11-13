import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "./shop.server";
import { eligibleStaff, isDayService, type ServiceFull } from "./booking.server";

/** App-proxy request → the shop row, or null when the signature is bad / shop unknown. */
export async function proxyShop(request: Request) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return null;
  return getShop(session.shop);
}

export function questionsFor(shopId: string, serviceId: string) {
  return prisma.bookingQuestion.findMany({
    where: { shopId, OR: [{ serviceId: null }, { serviceId }] },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
}

/** Everything the widget needs to render one service, in one request. */
export async function widgetConfig(shop: Awaited<ReturnType<typeof getShop>>, service: ServiceFull) {
  const [staff, questions, packages, waiver] = await Promise.all([
    service.staffMode === "staff" ? eligibleStaff(shop.id, service) : Promise.resolve([]),
    questionsFor(shop.id, service.id),
    prisma.package.findMany({ where: { shopId: shop.id, active: true }, select: { id: true, serviceIds: true } }),
    service.waiverId ? prisma.waiver.findFirst({ where: { id: service.waiverId, active: true }, select: { id: true, title: true, body: true } }) : Promise.resolve(null),
  ]);
  const lang = (shop.defaultLanguage || "en").slice(0, 2);
  const overrides = (shop.textOverrides ?? {}) as Record<string, Record<string, string>>;
  return {
    timezone: shop.timezone,
    currency: shop.currency,
    weekStartsOn: shop.weekStartsOn,
    use24h: shop.use24h,
    showSlotsLeft: shop.showSlotsLeft,
    showStaffSelector: shop.showStaffSelector,
    defaultLanguage: shop.defaultLanguage,
    multiLanguage: shop.multiLanguage,
    hideLogs: shop.hideWidgetLogs,
    smsAvailable: shop.smsEnabled,
    packagesAvailable: packages.some((p) => p.serviceIds.length === 0 || p.serviceIds.includes(service.id)),
    text: overrides,
    defaultLang: lang,
    design: { accent: shop.widgetAccent, radius: shop.widgetRadius, buttonText: shop.widgetButtonText },
    tracking: { ga: shop.gaMeasurementId, meta: shop.metaPixelId },
    service: {
      id: service.id,
      name: service.name,
      description: service.description,
      type: service.type,
      dayBased: isDayService(service),
      durationMinutes: service.durationMinutes,
      price: Number(service.price),
      capacity: service.resource ? service.resource.quantity : service.capacity,
      maxQuantity: service.maxQuantity,
      minDays: service.minDays,
      maxDays: service.maxDays,
      maxAdvanceDays: service.maxAdvanceDays,
      paymentMode: service.paymentMode,
      depositValue: Number(service.depositValue),
      allowRecurring: service.allowRecurring,
      allowMultiSlot: service.allowMultiSlot,
      maxSlots: service.maxSlots,
      maxRecurrences: service.maxRecurrences,
      waitlistEnabled: service.waitlistEnabled,
      virtual: service.type === "virtual",
      staffMode: service.staffMode,
      addons: service.addons.map((a) => ({ id: a.id, name: a.name, price: Number(a.price), durationMinutes: a.durationMinutes })),
    },
    waiver,
    staff: staff.map((s) => ({ id: s.id, name: s.name, bio: s.bio })),
    questions: questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options, required: q.required })),
  };
}
