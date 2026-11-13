import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  BookingNotFoundError,
  InvalidSlotError,
  SlotTakenError,
  cancelBookingById,
  findBookingByToken,
  isDayService,
  rescheduleBooking,
} from "../models/booking.server";
import { formatInTz, localParts } from "../models/time.server";
import { clientIp, rateLimited } from "../models/ratelimit.server";
import { onBookingCancelled, onBookingRescheduled } from "../models/lifecycle.server";

// Whether the customer may still change this booking (shop setting + cutoff).
function changeAllowed(shop: { cancelCutoffHours: number }, startsAt: Date) {
  return startsAt.getTime() - Date.now() > Math.max(0, shop.cancelCutoffHours) * 60 * 60_000;
}

// Reached at /apps/booking/manage?token=... on the storefront (the App
// Proxy strips the "/apps/booking" prefix, so this route lives at the
// bare path "/manage"). The token is the only credential — see
// manageToken on the Booking model — so a customer never needs an
// account to cancel or move their own appointment.
//
// This is a Remix "resource route": no default component is exported, so
// the loader's Response is returned to the browser as-is instead of
// being rendered inside the app's root document/layout. That lets a
// page meant for an anonymous storefront visitor render its own
// self-contained HTML instead of inheriting the embedded-admin shell.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Unknown shop", { status: 401 });

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  const t = pickTranslations(request, shop?.locale);

  const token = new URL(request.url).searchParams.get("token");
  if (!token) return htmlPage(t, renderMessage(t.useLinkFromEmail));

  const booking = await findBookingByToken(token);
  // The token must belong to the shop this proxy request came through.
  if (!booking || booking.shop.shopDomain !== session.shop) return htmlPage(t, renderMessage(t.notFound));

  if (["cancelled", "abandoned"].includes(booking.status)) {
    return htmlPage(t, renderMessage(t.alreadyCancelled));
  }
  if (booking.status === "pending") {
    return htmlPage(
      t,
      `<p class="bw-msg">${escapeHtml(t.awaitingPayment)}</p>` +
        (booking.checkoutUrl
          ? `<p style="margin-top:12px"><a class="bw-btn bw-pay" href="${escapeHtml(booking.checkoutUrl)}">${escapeHtml(t.completePayment)}</a></p>`
          : ""),
    );
  }
  const open = changeAllowed(booking.shop, booking.startsAt) && booking.startsAt.getTime() > Date.now();

  return htmlPage(
    t,
    renderBooking(t, {
      token,
      serviceId: booking.serviceId,
      serviceName: booking.service.name,
      durationMinutes: booking.service.durationMinutes,
      bufferMinutes: booking.service.bufferMinutes,
      staffId: booking.staffId ?? "",
      staffName: booking.staff?.name ?? "",
      dayBased: isDayService(booking.service),
      canCancel: open && booking.shop.allowCustomerCancel,
      canReschedule: open && booking.shop.allowCustomerReschedule,
      startsAt: booking.startsAt.toISOString(),
      customerName: booking.customerName,
      timezone: booking.shop.timezone,
      locale: acceptLocale(request),
    }),
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "Unknown shop" }, { status: 401 });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  if (rateLimited(`manage:${clientIp(request)}`, 20, 60_000)) {
    return json({ error: "Too many attempts. Please wait a minute." }, { status: 429 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, { status: 400 });
  }
  const token = String(body.token || "");
  const intent = String(body.intent || "");
  if (!token) return json({ error: "missing_token" }, { status: 400 });

  const existing = await findBookingByToken(token);
  if (!existing || existing.shop.shopDomain !== session.shop) {
    return json({ error: "That booking could not be found." }, { status: 404 });
  }

  const shop = existing.shop;
  if (!changeAllowed(shop, existing.startsAt)) {
    return json({ error: "This booking can no longer be changed online. Please contact the store." }, { status: 403 });
  }

  if (intent === "cancel") {
    if (!shop.allowCustomerCancel) return json({ error: "Online cancellation is turned off. Please contact the store." }, { status: 403 });
    const cancelled = await cancelBookingById(shop.id, existing.id, "customer");
    if (!cancelled) return json({ error: "That booking is already cancelled." }, { status: 409 });
    await onBookingCancelled(shop, existing.id, "customer");
    return json({ ok: true });
  }

  if (intent === "reschedule") {
    const startsAt = String(body.startsAt || "");
    if (!startsAt) return json({ error: "A new time is required." }, { status: 400 });

    if (!shop.allowCustomerReschedule) {
      return json({ error: "Online rescheduling is turned off. Please contact the store." }, { status: 403 });
    }
    try {
      const booking = await rescheduleBooking({ shop, bookingId: existing.id, startsAt: new Date(startsAt) });
      await onBookingRescheduled(shop, booking.id);
      return json({ ok: true, booking: { startsAt: booking.startsAt } });
    } catch (error) {
      if (error instanceof SlotTakenError || error instanceof BookingNotFoundError) {
        return json({ error: error.message }, { status: 409 });
      }
      if (error instanceof InvalidSlotError) return json({ error: error.message }, { status: 400 });
      throw error;
    }
  }

  return json({ error: "Unknown action" }, { status: 400 });
}

// Keeps the same small set of languages the storefront widget (see
// extensions/booking-widget/assets/booking.js) supports. The two can't
// share a module — this route ships in the Remix server bundle, the
// widget ships as a standalone theme extension asset — so the dict is
// duplicated rather than wired together across those two build targets.
type Translations = typeof EN;

const EN = {
  pageTitle: "Manage your booking",
  useLinkFromEmail: "Use the link from your booking confirmation to manage it.",
  notFound: "That booking could not be found.",
  alreadyCancelled: "This booking has been cancelled.",
  yourBooking: "Your booking",
  with: "with",
  reschedule: "Reschedule",
  cancelBooking: "Cancel booking",
  pickNewDate: "Pick a new date",
  pickTime: "Pick a time",
  noTimes: "No open times that day.",
  loadingTimes: "Loading times…",
  confirmCancel: "Cancel this booking?",
  couldNotCancel: "Could not cancel.",
  bookingCancelled: "Your booking has been cancelled.",
  slotJustTaken: "That time was just taken.",
  awaitingPayment: "This booking is waiting for payment. It will be confirmed once payment is complete.",
  completePayment: "Complete payment",
  contactStore: "To change this booking, please contact the store.",
  showAtCheckin: "Show this code at check-in.",
  addToCalendar: "Add to calendar",
};

const TRANSLATIONS: Record<string, Translations> = {
  en: EN,
  es: {
    pageTitle: "Gestiona tu reserva",
    useLinkFromEmail: "Usa el enlace de tu confirmación de reserva para gestionarla.",
    notFound: "No se encontró esa reserva.",
    alreadyCancelled: "Esta reserva ha sido cancelada.",
    yourBooking: "Tu reserva",
    with: "con",
    reschedule: "Reprogramar",
    cancelBooking: "Cancelar reserva",
    pickNewDate: "Elige una nueva fecha",
    pickTime: "Elige una hora",
    noTimes: "No hay horarios disponibles ese día.",
    loadingTimes: "Cargando horarios…",
    confirmCancel: "¿Cancelar esta reserva?",
    couldNotCancel: "No se pudo cancelar.",
    bookingCancelled: "Tu reserva ha sido cancelada.",
    slotJustTaken: "Ese horario acaba de ser reservado.",
    awaitingPayment: "Esta reserva está pendiente de pago. Se confirmará cuando se complete el pago.",
    completePayment: "Completar pago",
    contactStore: "Para cambiar esta reserva, contacta con la tienda.",
    showAtCheckin: "Muestra este código al llegar.",
    addToCalendar: "Añadir al calendario",
  },
  fr: {
    pageTitle: "Gérez votre réservation",
    useLinkFromEmail: "Utilisez le lien de votre confirmation de réservation pour la gérer.",
    notFound: "Cette réservation est introuvable.",
    alreadyCancelled: "Cette réservation a été annulée.",
    yourBooking: "Votre réservation",
    with: "avec",
    reschedule: "Reprogrammer",
    cancelBooking: "Annuler la réservation",
    pickNewDate: "Choisissez une nouvelle date",
    pickTime: "Choisissez un horaire",
    noTimes: "Aucun créneau disponible ce jour-là.",
    loadingTimes: "Chargement des horaires…",
    confirmCancel: "Annuler cette réservation ?",
    couldNotCancel: "Impossible d'annuler.",
    bookingCancelled: "Votre réservation a été annulée.",
    slotJustTaken: "Ce créneau vient d'être réservé.",
    awaitingPayment: "Cette réservation attend le paiement. Elle sera confirmée une fois le paiement effectué.",
    completePayment: "Finaliser le paiement",
    contactStore: "Pour modifier cette réservation, contactez la boutique.",
    showAtCheckin: "Présentez ce code à l'accueil.",
    addToCalendar: "Ajouter au calendrier",
  },
  de: {
    pageTitle: "Buchung verwalten",
    useLinkFromEmail: "Verwende den Link aus deiner Buchungsbestätigung, um sie zu verwalten.",
    notFound: "Diese Buchung konnte nicht gefunden werden.",
    alreadyCancelled: "Diese Buchung wurde storniert.",
    yourBooking: "Deine Buchung",
    with: "mit",
    reschedule: "Verschieben",
    cancelBooking: "Buchung stornieren",
    pickNewDate: "Wähle ein neues Datum",
    pickTime: "Wähle eine Uhrzeit",
    noTimes: "An diesem Tag sind keine Termine frei.",
    loadingTimes: "Zeiten werden geladen…",
    confirmCancel: "Diese Buchung stornieren?",
    couldNotCancel: "Stornierung nicht möglich.",
    bookingCancelled: "Deine Buchung wurde storniert.",
    slotJustTaken: "Dieser Termin wurde gerade vergeben.",
    awaitingPayment: "Diese Buchung wartet auf die Zahlung. Sie wird bestätigt, sobald die Zahlung abgeschlossen ist.",
    completePayment: "Zahlung abschließen",
    contactStore: "Um diese Buchung zu ändern, kontaktiere bitte den Shop.",
    showAtCheckin: "Zeige diesen Code beim Check-in.",
    addToCalendar: "Zum Kalender hinzufügen",
  },
};

function acceptLocale(request: Request) {
  const raw = request.headers.get("Accept-Language")?.split(",")[0]?.trim();
  return raw && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(raw) ? raw : "en-US";
}

function pickTranslations(request: Request, shopLocale?: string): Translations {
  const acceptLang = request.headers.get("Accept-Language")?.slice(0, 2).toLowerCase();
  const lang = acceptLang && TRANSLATIONS[acceptLang] ? acceptLang : shopLocale?.slice(0, 2).toLowerCase();
  return (lang && TRANSLATIONS[lang]) || EN;
}

function htmlPage(t: Translations, bodyHtml: string) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(t.pageTitle)}</title><style>${STYLES}</style></head><body><div class="bw-manage">${bodyHtml}</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function renderMessage(text: string) {
  return `<p class="bw-msg">${escapeHtml(text)}</p>`;
}

function renderBooking(
  t: Translations,
  b: {
    token: string;
    serviceId: string;
    serviceName: string;
    durationMinutes: number;
    bufferMinutes: number;
    staffId: string;
    staffName: string;
    dayBased: boolean;
    canCancel: boolean;
    canReschedule: boolean;
    startsAt: string;
    customerName: string;
    timezone: string;
    locale: string;
  },
) {
  return `
    <h1>${escapeHtml(t.yourBooking)}</h1>
    <div class="bw-card" id="bw-summary">
      <p class="bw-service">${escapeHtml(b.serviceName)}</p>
      <p class="bw-when" data-starts-at="${escapeHtml(b.startsAt)}">${escapeHtml(formatWhen(b.startsAt, b.timezone, b.locale, b.dayBased))}</p>
      ${b.staffName ? `<p class="bw-with">${escapeHtml(t.with)} ${escapeHtml(b.staffName)}</p>` : ""}
    </div>
    <div class="bw-card" style="margin-top:12px;text-align:center"><img src="/apps/booking/qrcode?token=${encodeURIComponent(b.token)}" width="150" height="150" alt="Ticket QR code"><p class="bw-with">${escapeHtml(t.showAtCheckin)}</p></div>
    <p style="text-align:center;margin:10px 0 0"><a class="bw-with" href="/apps/booking/ics?token=${encodeURIComponent(b.token)}">${escapeHtml(t.addToCalendar)}</a></p>
    <div class="bw-actions">
      ${b.canReschedule ? `<button type="button" id="bw-toggle-reschedule" class="bw-btn">${escapeHtml(t.reschedule)}</button>` : ""}
      ${b.canCancel ? `<button type="button" id="bw-cancel" class="bw-btn bw-btn-danger">${escapeHtml(t.cancelBooking)}</button>` : ""}
    </div>
    ${!b.canCancel && !b.canReschedule ? `<p class="bw-with" style="margin-top:12px">${escapeHtml(t.contactStore)}</p>` : ""}
    <div id="bw-reschedule-panel" style="display:none"></div>
    <p class="bw-error" id="bw-error"></p>
    <script>
      (function () {
        var token = ${scriptJson(b.token)};
        var serviceId = ${scriptJson(b.serviceId)};
        var staffId = ${scriptJson(b.staffId)};
        var tz = ${scriptJson(b.timezone)};
        var locale = ${scriptJson(b.locale)};
        var todayInShop = ${scriptJson(localParts(new Date(), b.timezone).dateStr)};
        var i18n = ${scriptJson({
          pickNewDate: t.pickNewDate,
          pickTime: t.pickTime,
          noTimes: t.noTimes,
          loadingTimes: t.loadingTimes,
          confirmCancel: t.confirmCancel,
          couldNotCancel: t.couldNotCancel,
          bookingCancelled: t.bookingCancelled,
          slotJustTaken: t.slotJustTaken,
        })};

        var errorEl = document.getElementById("bw-error");
        var panel = document.getElementById("bw-reschedule-panel");

        function proxyUrl(path) { return "/apps/booking" + path; }

        var dayBased = ${scriptJson(b.dayBased)};
        var cancelBtn = document.getElementById("bw-cancel");
        if (cancelBtn) cancelBtn.addEventListener("click", function () {
          if (!confirm(i18n.confirmCancel)) return;
          fetch(proxyUrl("/manage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: token, intent: "cancel" }),
          })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (res) {
              if (!res.ok) { errorEl.textContent = res.d.error || i18n.couldNotCancel; return; }
              document.querySelector(".bw-manage").innerHTML = '<p class="bw-msg">' + i18n.bookingCancelled + '</p>';
            });
        });

        var reBtn = document.getElementById("bw-toggle-reschedule");
        if (reBtn) reBtn.addEventListener("click", function () {
          panel.style.display = panel.style.display === "none" ? "block" : "none";
          if (panel.style.display === "block") renderDates();
        });

        function renderDates() {
          var html = '<p class="bw-label">' + i18n.pickNewDate + '</p><div class="bw-dates">';
          for (var i = 0; i < 14; i++) {
            var d = new Date(Date.parse(todayInShop + "T12:00:00Z") + i * 86400000);
            html += '<span class="bw-slot" data-date="' + d.toISOString().slice(0, 10) + '">' +
              d.toLocaleDateString(locale, { weekday: "short", day: "numeric", timeZone: "UTC" }) + "</span>";
          }
          html += '</div><div class="bw-times"></div>';
          panel.innerHTML = html;
          panel.querySelectorAll(".bw-dates .bw-slot").forEach(function (el) {
            el.addEventListener("click", function () {
              panel.querySelectorAll(".bw-dates .bw-slot").forEach(function (s) { s.classList.remove("bw-selected"); });
              el.classList.add("bw-selected");
              loadTimes(el.dataset.date);
            });
          });
        }

        function loadTimes(date) {
          var timesEl = panel.querySelector(".bw-times");
          timesEl.innerHTML = "<p>" + i18n.loadingTimes + "</p>";
          fetch(proxyUrl("/availability?serviceId=" + encodeURIComponent(serviceId) + "&staffId=" + encodeURIComponent(staffId) + "&date=" + date + "&excludeToken=" + encodeURIComponent(token)))
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (!data.slots || !data.slots.length) { timesEl.innerHTML = "<p>" + i18n.noTimes + "</p>"; return; }
              var html = '<p class="bw-label">' + i18n.pickTime + '</p>';
              data.slots.forEach(function (slot) {
                var time = new Date(slot.startsAt);
                var label = dayBased ? time.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", timeZone: tz }) : time.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone: tz });
                html += '<span class="bw-slot ' + (slot.available ? "" : "bw-taken") + '" data-starts-at="' + slot.startsAt + '">' + label + "</span>";
              });
              timesEl.innerHTML = html;
              timesEl.querySelectorAll(".bw-slot:not(.bw-taken)").forEach(function (el) {
                el.addEventListener("click", function () { confirmReschedule(el.dataset.startsAt); });
              });
            });
        }

        function confirmReschedule(startsAt) {
          fetch(proxyUrl("/manage"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: token, intent: "reschedule", startsAt: startsAt }),
          })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
            .then(function (res) {
              if (!res.ok) { errorEl.textContent = res.d.error || i18n.slotJustTaken; return; }
              errorEl.textContent = "";
              panel.style.display = "none";
              document.querySelector(".bw-when").textContent = new Date(startsAt).toLocaleString(locale, dayBased
                ? { weekday: "long", month: "long", day: "numeric", timeZone: tz }
                : { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
            });
        }
      })();
    </script>
  `;
}

function formatWhen(iso: string, tz: string, locale: string, dayBased = false) {
  return formatInTz(
    new Date(iso),
    tz,
    dayBased
      ? { weekday: "long", month: "long", day: "numeric" }
      : { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" },
    locale,
  );
}

// JSON safe to embed inside an inline <script>.
function scriptJson(v: unknown) {
  return JSON.stringify(v)
    .replace(/</g, "\u003c")
    .replace(/>/g, "\u003e")
    .replace(/&/g, "\u0026");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const STYLES = `
  @import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600&family=Inter:wght@400;500;600;700&display=swap");
  :root { --accent:#5b5bd6; --accent-2:#8d6fe0; --border:#e1e0f5; --fg:#201f3d; --muted:#6c6a92; }
  * { box-sizing:border-box; }
  body { margin:0; background:#f6f6fb; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--fg); }
  .bw-manage { max-width:440px; margin:40px auto; padding:0 16px; }
  h1 { font-family:"Space Grotesk","Inter",sans-serif; font-size:22px; margin:0 0 16px; letter-spacing:-0.01em; }
  .bw-card { background:#fff; border:1px solid var(--border); border-radius:14px; padding:18px; box-shadow:0 1px 2px rgba(32,30,60,.07),0 8px 24px rgba(32,30,60,.08); }
  .bw-service { font-weight:700; margin:0 0 4px; font-size:16px; }
  .bw-when { margin:0 0 4px; color:var(--accent); font-weight:600; }
  .bw-with { margin:0; color:var(--muted); font-size:13px; }
  .bw-actions { display:flex; gap:10px; margin-top:16px; }
  .bw-btn { flex:1; padding:11px 14px; border-radius:10px; border:1px solid var(--border); background:#fff; color:var(--fg); font-weight:700; font-family:inherit; cursor:pointer; }
  #bw-toggle-reschedule { background:linear-gradient(135deg,var(--accent),var(--accent-2)); border-color:transparent; color:#fff; }
  .bw-pay { display:inline-block; text-decoration:none; text-align:center; background:linear-gradient(135deg,var(--accent),var(--accent-2)); color:#fff; border-color:transparent; }
  .bw-btn-danger { color:#b23a2e; border-color:#f1c7c0; }
  .bw-label { font-weight:700; margin:16px 0 8px; font-size:13.5px; }
  .bw-dates, .bw-times { display:flex; flex-wrap:wrap; gap:8px; }
  .bw-slot { padding:9px 13px; border-radius:10px; border:1px solid var(--border); background:#fff; cursor:pointer; font-size:13px; font-weight:600; }
  .bw-slot:hover { border-color:var(--accent); color:var(--accent); }
  .bw-slot.bw-selected { background:linear-gradient(135deg,var(--accent),var(--accent-2)); color:#fff; border-color:var(--accent); }
  .bw-slot.bw-taken { opacity:0.35; cursor:not-allowed; text-decoration:line-through; }
  .bw-error { color:#b23a2e; font-size:13px; margin-top:10px; }
  .bw-msg { background:#fff; border:1px solid var(--border); border-radius:14px; padding:18px; box-shadow:0 1px 2px rgba(32,30,60,.07),0 8px 24px rgba(32,30,60,.08); }
`;
