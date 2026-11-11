import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  BookingNotFoundError,
  SlotTakenError,
  cancelBooking,
  findBookingByToken,
  rescheduleBooking,
} from "../models/booking.server";
import { deleteGoogleCalendarEvent, updateGoogleCalendarEvent } from "../models/calendar.server";

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
  if (!booking) return htmlPage(t, renderMessage(t.notFound));

  if (booking.status === "cancelled") {
    return htmlPage(t, renderMessage(t.alreadyCancelled));
  }

  return htmlPage(
    t,
    renderBooking(t, {
      token,
      serviceId: booking.serviceId,
      serviceName: booking.service.name,
      durationMinutes: booking.service.durationMinutes,
      bufferMinutes: booking.service.bufferMinutes,
      staffId: booking.staffId,
      staffName: booking.staff.name,
      startsAt: booking.startsAt.toISOString(),
      customerName: booking.customerName,
    }),
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "Unknown shop" }, { status: 401 });

  const body = await request.json();
  const token = String(body.token || "");
  const intent = String(body.intent || "");
  if (!token) return json({ error: "missing_token" }, { status: 400 });

  if (intent === "cancel") {
    const existing = await findBookingByToken(token);
    const ok = await cancelBooking(token);
    if (!ok) return json({ error: "That booking is already cancelled." }, { status: 409 });

    if (existing?.googleEventId) {
      const shop = await prisma.shop.findUnique({ where: { id: existing.shopId } });
      if (shop) deleteGoogleCalendarEvent(shop, existing.googleEventId).catch(() => {});
    }

    return json({ ok: true });
  }

  if (intent === "reschedule") {
    const startsAt = String(body.startsAt || "");
    if (!startsAt) return json({ error: "A new time is required." }, { status: 400 });

    const existing = await findBookingByToken(token);
    if (!existing) return json({ error: "not_found" }, { status: 404 });

    try {
      const booking = await rescheduleBooking({
        manageToken: token,
        startsAt: new Date(startsAt),
        durationMinutes: existing.service.durationMinutes + existing.service.bufferMinutes,
      });

      if (existing.googleEventId) {
        const shop = await prisma.shop.findUnique({ where: { id: existing.shopId } });
        if (shop) {
          updateGoogleCalendarEvent(shop, existing.googleEventId, {
            startsAt: booking.startsAt,
            endsAt: booking.endsAt,
          }).catch(() => {});
        }
      }

      return json({ ok: true, booking });
    } catch (error) {
      if (error instanceof SlotTakenError || error instanceof BookingNotFoundError) {
        return json({ error: error.message }, { status: 409 });
      }
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
  },
};

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
    startsAt: string;
    customerName: string;
  },
) {
  return `
    <h1>${escapeHtml(t.yourBooking)}</h1>
    <div class="bw-card" id="bw-summary">
      <p class="bw-service">${escapeHtml(b.serviceName)}</p>
      <p class="bw-when" data-starts-at="${b.startsAt}">${formatWhen(b.startsAt)}</p>
      <p class="bw-with">${escapeHtml(t.with)} ${escapeHtml(b.staffName)}</p>
    </div>
    <div class="bw-actions">
      <button type="button" id="bw-toggle-reschedule" class="bw-btn">${escapeHtml(t.reschedule)}</button>
      <button type="button" id="bw-cancel" class="bw-btn bw-btn-danger">${escapeHtml(t.cancelBooking)}</button>
    </div>
    <div id="bw-reschedule-panel" style="display:none"></div>
    <p class="bw-error" id="bw-error"></p>
    <script>
      (function () {
        var token = ${JSON.stringify(b.token)};
        var serviceId = ${JSON.stringify(b.serviceId)};
        var staffId = ${JSON.stringify(b.staffId)};
        var durationMinutes = ${b.durationMinutes};
        var bufferMinutes = ${b.bufferMinutes};
        var i18n = ${JSON.stringify({
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

        document.getElementById("bw-cancel").addEventListener("click", function () {
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

        document.getElementById("bw-toggle-reschedule").addEventListener("click", function () {
          panel.style.display = panel.style.display === "none" ? "block" : "none";
          if (panel.style.display === "block") renderDates();
        });

        function renderDates() {
          var html = '<p class="bw-label">' + i18n.pickNewDate + '</p><div class="bw-dates">';
          var today = new Date();
          for (var i = 0; i < 7; i++) {
            var d = new Date(today.getTime() + i * 86400000);
            html += '<span class="bw-slot" data-date="' + d.toISOString().slice(0, 10) + '">' +
              d.toLocaleDateString(document.documentElement.lang || undefined, { weekday: "short", day: "numeric" }) + "</span>";
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
          fetch(proxyUrl("/availability?serviceId=" + serviceId + "&staffId=" + staffId + "&date=" + date))
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (!data.slots || !data.slots.length) { timesEl.innerHTML = "<p>" + i18n.noTimes + "</p>"; return; }
              var html = '<p class="bw-label">' + i18n.pickTime + '</p>';
              data.slots.forEach(function (slot) {
                var time = new Date(slot.startsAt);
                var label = time.toLocaleTimeString(document.documentElement.lang || undefined, { hour: "numeric", minute: "2-digit" });
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
              document.querySelector(".bw-when").textContent = new Date(startsAt).toLocaleString(document.documentElement.lang || undefined, {
                weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
              });
            });
        }
      })();
    </script>
  `;
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const STYLES = `
  body { margin:0; background:#f6f5fb; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#1c1c28; }
  .bw-manage { max-width:420px; margin:40px auto; padding:0 20px; }
  h1 { font-size:20px; margin:0 0 16px; }
  .bw-card { background:#fff; border-radius:12px; padding:18px; box-shadow:0 2px 10px rgba(32,22,82,0.08); }
  .bw-service { font-weight:700; margin:0 0 4px; }
  .bw-when { margin:0 0 4px; color:#5b5bd6; font-weight:600; }
  .bw-with { margin:0; color:#666; font-size:13px; }
  .bw-actions { display:flex; gap:10px; margin-top:16px; }
  .bw-btn { flex:1; padding:10px 14px; border-radius:8px; border:1px solid #d7d3ea; background:#fff; font-weight:600; cursor:pointer; }
  .bw-btn-danger { color:#c0392b; border-color:#f1c7c0; }
  .bw-label { font-weight:600; margin:16px 0 8px; }
  .bw-dates, .bw-times { display:flex; flex-wrap:wrap; gap:8px; }
  .bw-slot { padding:8px 12px; border-radius:8px; border:1px solid #d7d3ea; cursor:pointer; font-size:13px; }
  .bw-slot.bw-selected { background:#5b5bd6; color:#fff; border-color:#5b5bd6; }
  .bw-slot.bw-taken { opacity:0.35; cursor:not-allowed; text-decoration:line-through; }
  .bw-error { color:#c0392b; font-size:13px; margin-top:10px; }
  .bw-msg { background:#fff; border-radius:12px; padding:18px; box-shadow:0 2px 10px rgba(32,22,82,0.08); }
`;
