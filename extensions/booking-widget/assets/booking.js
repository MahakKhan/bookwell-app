(function () {
  "use strict";

  var root = document.getElementById("bookwell-widget");
  if (!root) return;

  var serviceId = root.dataset.serviceId;
  var accent = root.dataset.accent;
  if (accent) root.style.setProperty("--bw-accent", accent);

  // Widget text follows the storefront's own active language (the <html
  // lang="xx"> Shopify already sets per visitor/market) with no extra
  // network request. Falls back to English for any language we haven't
  // translated yet rather than showing missing strings.
  var TRANSLATIONS = {
    en: {
      bookBtn: "Book an appointment",
      loadingStaff: "Loading staff…",
      noStaff: "No staff available for booking yet.",
      pickStaff: "Pick a team member",
      pickDate: "Pick a date",
      loadingTimes: "Loading times…",
      noTimes: "No open times that day.",
      pickTime: "Pick a time",
      namePlaceholder: "Full name",
      emailPlaceholder: "Email",
      phonePlaceholder: "Phone (for SMS reminder)",
      smsOptIn: "Text me a reminder",
      confirmBtn: "Confirm booking",
      nameEmailRequired: "Name and email are required.",
      slotTaken: "That slot was just taken. Pick another.",
      confirmed: "Booking confirmed",
      confirmationSent: "A confirmation has been sent to ",
      manageLink: "Reschedule or cancel this booking",
    },
    es: {
      bookBtn: "Reservar una cita",
      loadingStaff: "Cargando personal…",
      noStaff: "Aún no hay personal disponible para reservas.",
      pickStaff: "Elige un miembro del equipo",
      pickDate: "Elige una fecha",
      loadingTimes: "Cargando horarios…",
      noTimes: "No hay horarios disponibles ese día.",
      pickTime: "Elige una hora",
      namePlaceholder: "Nombre completo",
      emailPlaceholder: "Correo electrónico",
      phonePlaceholder: "Teléfono (para recordatorio SMS)",
      smsOptIn: "Env\u00ienme un recordatorio",
      confirmBtn: "Confirmar reserva",
      nameEmailRequired: "El nombre y el correo son obligatorios.",
      slotTaken: "Ese horario acaba de ser reservado. Elige otro.",
      confirmed: "Reserva confirmada",
      confirmationSent: "Se ha enviado una confirmación a ",
      manageLink: "Reprogramar o cancelar esta reserva",
    },
    fr: {
      bookBtn: "Prendre un rendez-vous",
      loadingStaff: "Chargement du personnel…",
      noStaff: "Aucun membre du personnel disponible pour le moment.",
      pickStaff: "Choisissez un membre de l'équipe",
      pickDate: "Choisissez une date",
      loadingTimes: "Chargement des horaires…",
      noTimes: "Aucun créneau disponible ce jour-là.",
      pickTime: "Choisissez un horaire",
      namePlaceholder: "Nom complet",
      emailPlaceholder: "E-mail",
      phonePlaceholder: "Téléphone (rappel SMS)",
      smsOptIn: "Envoyez-moi un rappel",
      confirmBtn: "Confirmer la réservation",
      nameEmailRequired: "Le nom et l'e-mail sont obligatoires.",
      slotTaken: "Ce créneau vient d'être réservé. Choisissez-en un autre.",
      confirmed: "Réservation confirmée",
      confirmationSent: "Une confirmation a été envoyée à ",
      manageLink: "Reprogrammer ou annuler cette réservation",
    },
    de: {
      bookBtn: "Termin buchen",
      loadingStaff: "Mitarbeiter werden geladen…",
      noStaff: "Derzeit ist kein Personal für Buchungen verfügbar.",
      pickStaff: "Wähle ein Teammitglied",
      pickDate: "Wähle ein Datum",
      loadingTimes: "Zeiten werden geladen…",
      noTimes: "An diesem Tag sind keine Termine frei.",
      pickTime: "Wähle eine Uhrzeit",
      namePlaceholder: "Vollständiger Name",
      emailPlaceholder: "E-Mail",
      phonePlaceholder: "Telefon (für SMS-Erinnerung)",
      smsOptIn: "Erinnere mich per SMS",
      confirmBtn: "Buchung bestätigen",
      nameEmailRequired: "Name und E-Mail sind erforderlich.",
      slotTaken: "Dieser Termin wurde gerade vergeben. Wähle einen anderen.",
      confirmed: "Buchung bestätigt",
      confirmationSent: "Eine Bestätigung wurde gesendet an ",
      manageLink: "Diese Buchung verschieben oder stornieren",
    },
  };

  var lang = (root.dataset.lang || document.documentElement.lang || "en")
    .slice(0, 2)
    .toLowerCase();
  var t = TRANSLATIONS[lang] || TRANSLATIONS.en;
  var dateLocale = document.documentElement.lang || undefined;

  var state = { staffId: null, date: null, startsAt: null };

  root.innerHTML =
    '<button class="bw-book-btn" type="button">' + t.bookBtn + "</button>" +
    '<div class="bw-panel" style="display:none"></div>';

  var button = root.querySelector(".bw-book-btn");
  var panel = root.querySelector(".bw-panel");

  button.addEventListener("click", function () {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
    if (panel.style.display === "block") renderStaffPicker();
  });

  function proxyUrl(path) {
    return "/apps/booking" + path;
  }

  function renderStaffPicker() {
    panel.innerHTML = "<p>" + t.loadingStaff + "</p>";

    fetch(proxyUrl("/staff"))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var members = data.staff || [];

        if (members.length === 0) {
          panel.innerHTML = "<p>" + t.noStaff + "</p>";
          return;
        }

        if (members.length === 1) {
          state.staffId = members[0].id;
          renderDatePicker();
          return;
        }

        var html = '<p style="margin:0 0 8px;font-weight:600">' + t.pickStaff + '</p><div class="bw-staff">';
        members.forEach(function (member) {
          html +=
            '<span class="bw-slot" data-staff-id="' + member.id + '">' + member.name + "</span>";
        });
        html += "</div>";
        panel.innerHTML = html;

        panel.querySelectorAll(".bw-staff .bw-slot").forEach(function (el) {
          el.addEventListener("click", function () {
            state.staffId = el.dataset.staffId;
            renderDatePicker();
          });
        });
      });
  }

  function renderDatePicker() {
    var today = new Date();
    var html = '<p style="margin:0 0 8px;font-weight:600">' + t.pickDate + '</p><div class="bw-dates">';
    for (var i = 0; i < 5; i++) {
      var d = new Date(today.getTime() + i * 86400000);
      html +=
        '<span class="bw-slot" data-date="' +
        d.toISOString().slice(0, 10) +
        '">' +
        d.toLocaleDateString(dateLocale, { weekday: "short", day: "numeric" }) +
        "</span>";
    }
    html += '</div><div class="bw-times"></div><div class="bw-form" style="display:none"></div>';
    panel.innerHTML = html;

    panel.querySelectorAll(".bw-dates .bw-slot").forEach(function (el) {
      el.addEventListener("click", function () {
        panel.querySelectorAll(".bw-dates .bw-slot").forEach(function (s) {
          s.classList.remove("bw-selected");
        });
        el.classList.add("bw-selected");
        state.date = el.dataset.date;
        loadTimes();
      });
    });
  }

  function loadTimes() {
    var timesEl = panel.querySelector(".bw-times");
    timesEl.innerHTML = "<p>" + t.loadingTimes + "</p>";

    fetch(
      proxyUrl(
        "/availability?serviceId=" +
          serviceId +
          "&staffId=" +
          state.staffId +
          "&date=" +
          state.date,
      ),
    )
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!data.slots || !data.slots.length) {
          timesEl.innerHTML = "<p>" + t.noTimes + "</p>";
          return;
        }
        var html = '<p style="margin:10px 0 8px;font-weight:600">' + t.pickTime + "</p>";
        data.slots.forEach(function (slot) {
          var time = new Date(slot.startsAt);
          var label = time.toLocaleTimeString(dateLocale, {
            hour: "numeric",
            minute: "2-digit",
          });
          html +=
            '<span class="bw-slot ' +
            (slot.available ? "" : "bw-taken") +
            '" data-starts-at="' +
            slot.startsAt +
            '">' +
            label +
            "</span>";
        });
        timesEl.innerHTML = html;

        timesEl.querySelectorAll(".bw-slot:not(.bw-taken)").forEach(function (el) {
          el.addEventListener("click", function () {
            timesEl.querySelectorAll(".bw-slot").forEach(function (s) {
              s.classList.remove("bw-selected");
            });
            el.classList.add("bw-selected");
            state.startsAt = el.dataset.startsAt;
            renderForm();
          });
        });
      });
  }

  function renderForm() {
    var formEl = panel.querySelector(".bw-form");
    formEl.style.display = "block";
    formEl.innerHTML =
      '<input type="text" placeholder="' + t.namePlaceholder + '" class="bw-name">' +
      '<input type="email" placeholder="' + t.emailPlaceholder + '" class="bw-email">' +
      '<input type="tel" placeholder="' + t.phonePlaceholder + '" class="bw-phone">' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px">' +
      '<input type="checkbox" class="bw-sms" checked> ' + t.smsOptIn + "</label>" +
      '<button type="button" class="bw-book-btn bw-confirm">' + t.confirmBtn + "</button>" +
      '<div class="bw-error"></div>';

    formEl.querySelector(".bw-confirm").addEventListener("click", confirmBooking);
  }

  function confirmBooking() {
    var errorEl = panel.querySelector(".bw-error");
    var name = panel.querySelector(".bw-name").value.trim();
    var email = panel.querySelector(".bw-email").value.trim();
    var phone = panel.querySelector(".bw-phone").value.trim();
    var smsOptIn = panel.querySelector(".bw-sms").checked;

    if (!name || !email) {
      errorEl.textContent = t.nameEmailRequired;
      return;
    }

    fetch(proxyUrl("/bookings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId: serviceId,
        staffId: state.staffId,
        startsAt: state.startsAt,
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        smsOptIn: smsOptIn,
      }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          errorEl.textContent = result.data.error || t.slotTaken;
          loadTimes();
          return;
        }
        var manageToken = result.data.booking && result.data.booking.manageToken;
        panel.innerHTML =
          '<p style="font-weight:700;margin:0 0 4px">' + t.confirmed + "</p>" +
          '<p style="margin:0 0 8px;color:#666;font-size:13px">' + t.confirmationSent +
          email +
          ".</p>" +
          (manageToken
            ? '<a href="' +
              proxyUrl("/manage?token=" + manageToken) +
              '" style="font-size:13px;color:var(--bw-accent,#5b5bd6);font-weight:600">' + t.manageLink + "</a>"
            : "");
      });
  }
})();
