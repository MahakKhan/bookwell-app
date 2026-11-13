(function () {
  "use strict";

  // Bookwell storefront widget. Renders into every element with
  // class="bookwell-widget" (or the legacy id="bookwell-widget") that carries
  // data-service-id. All data comes from the app proxy at /apps/booking/*.

  var EN = {
    bookBtn: "Book an appointment",
    loading: "Loading…",
    unavailable: "Booking isn't available for this item right now.",
    pickStaff: "Choose who you'd like",
    anyStaff: "Any available",
    pickDate: "Pick a date",
    pickStart: "Pick your start date",
    pickEnd: "Now pick your end date",
    pickTime: "Pick a time",
    noTimes: "No open times that day.",
    spots: "spots",
    left: "left",
    full: "Full",
    joinWaitlist: "Join waitlist",
    quantity: "How many?",
    addons: "Add-ons",
    repeat: "Repeat",
    repeatNone: "Just once",
    repeatWeekly: "Every week",
    repeat2: "Every 2 weeks",
    repeat4: "Every 4 weeks",
    sessions: "sessions",
    namePlaceholder: "Full name",
    emailPlaceholder: "Email",
    phonePlaceholder: "Phone",
    smsOptIn: "Text me a reminder",
    confirmBtn: "Confirm booking",
    payBtn: "Continue to payment",
    payDeposit: "Pay deposit",
    total: "Total",
    dueNow: "Due now",
    days: "days",
    nameEmailRequired: "Name and email are required.",
    answerRequired: "Please answer: ",
    slotTaken: "That slot was just taken. Pick another.",
    confirmed: "Booking confirmed",
    confirmationSent: "A confirmation has been sent to ",
    manageLink: "Reschedule or cancel this booking",
    redirecting: "Taking you to secure checkout…",
    waitlistTitle: "Join the waitlist",
    waitlistJoined: "You're on the waitlist. We'll email you if a spot opens up.",
    genericError: "Something went wrong. Please try again.",
    allDay: "All day",
    online: "Online",
    free: "Free",
    min: "min",
    usePackage: "Use my package or membership",
    buyPackage: "Buy a package",
    selectedTimes: "Selected times",
    pickUpTo: "Pick up to {n} times",
    remove: "Remove",
    waiverAgree: "I have read and agree to the waiver",
    waiverName: "Type your full name",
    waiverSign: "Sign here",
    waiverClear: "Clear",
    waiverRequired: "Please accept the waiver, type your name and sign.",
  };

  var TR = {
    es: {
      bookBtn: "Reservar una cita", loading: "Cargando…", pickStaff: "Elige con quién", anyStaff: "Cualquiera disponible",
      pickDate: "Elige una fecha", pickStart: "Elige la fecha de inicio", pickEnd: "Ahora elige la fecha final", pickTime: "Elige una hora",
      noTimes: "No hay horarios disponibles ese día.", left: "libres", full: "Completo", joinWaitlist: "Lista de espera", quantity: "¿Cuántos?",
      addons: "Extras", repeat: "Repetir", repeatNone: "Solo una vez", repeatWeekly: "Cada semana", repeat2: "Cada 2 semanas", repeat4: "Cada 4 semanas",
      sessions: "sesiones", namePlaceholder: "Nombre completo", emailPlaceholder: "Correo electrónico", phonePlaceholder: "Teléfono",
      smsOptIn: "Envíenme un recordatorio", confirmBtn: "Confirmar reserva", payBtn: "Continuar al pago", payDeposit: "Pagar depósito", total: "Total",
      dueNow: "A pagar ahora", days: "días", nameEmailRequired: "El nombre y el correo son obligatorios.", answerRequired: "Responde: ",
      slotTaken: "Ese horario acaba de ser reservado. Elige otro.", confirmed: "Reserva confirmada", confirmationSent: "Se ha enviado una confirmación a ",
      manageLink: "Reprogramar o cancelar esta reserva", redirecting: "Te llevamos al pago seguro…", waitlistTitle: "Unirse a la lista de espera",
      waitlistJoined: "Estás en la lista de espera. Te avisaremos si se libera un hueco.", genericError: "Algo salió mal. Inténtalo de nuevo.",
      allDay: "Todo el día", free: "Gratis",
    },
    fr: {
      bookBtn: "Prendre un rendez-vous", loading: "Chargement…", pickStaff: "Avec qui ?", anyStaff: "Peu importe",
      pickDate: "Choisissez une date", pickStart: "Choisissez la date de début", pickEnd: "Choisissez la date de fin", pickTime: "Choisissez un horaire",
      noTimes: "Aucun créneau disponible ce jour-là.", left: "restant(s)", full: "Complet", joinWaitlist: "Liste d'attente", quantity: "Combien ?",
      addons: "Options", repeat: "Répéter", repeatNone: "Une seule fois", repeatWeekly: "Chaque semaine", repeat2: "Toutes les 2 semaines", repeat4: "Toutes les 4 semaines",
      sessions: "séances", namePlaceholder: "Nom complet", emailPlaceholder: "E-mail", phonePlaceholder: "Téléphone", smsOptIn: "Envoyez-moi un rappel",
      confirmBtn: "Confirmer la réservation", payBtn: "Continuer vers le paiement", payDeposit: "Payer l'acompte", total: "Total", dueNow: "À payer maintenant",
      days: "jours", nameEmailRequired: "Le nom et l'e-mail sont obligatoires.", answerRequired: "Veuillez répondre : ",
      slotTaken: "Ce créneau vient d'être réservé. Choisissez-en un autre.", confirmed: "Réservation confirmée", confirmationSent: "Une confirmation a été envoyée à ",
      manageLink: "Reprogrammer ou annuler cette réservation", redirecting: "Redirection vers le paiement sécurisé…", waitlistTitle: "Rejoindre la liste d'attente",
      waitlistJoined: "Vous êtes sur la liste d'attente. Nous vous écrirons si une place se libère.", genericError: "Une erreur est survenue. Veuillez réessayer.",
      allDay: "Toute la journée", free: "Gratuit",
    },
    de: {
      bookBtn: "Termin buchen", loading: "Wird geladen…", pickStaff: "Bei wem?", anyStaff: "Egal",
      pickDate: "Wähle ein Datum", pickStart: "Wähle das Startdatum", pickEnd: "Wähle jetzt das Enddatum", pickTime: "Wähle eine Uhrzeit",
      noTimes: "An diesem Tag sind keine Termine frei.", left: "frei", full: "Ausgebucht", joinWaitlist: "Warteliste", quantity: "Wie viele?",
      addons: "Extras", repeat: "Wiederholen", repeatNone: "Nur einmal", repeatWeekly: "Jede Woche", repeat2: "Alle 2 Wochen", repeat4: "Alle 4 Wochen",
      sessions: "Termine", namePlaceholder: "Vollständiger Name", emailPlaceholder: "E-Mail", phonePlaceholder: "Telefon", smsOptIn: "Erinnere mich per SMS",
      confirmBtn: "Buchung bestätigen", payBtn: "Weiter zur Zahlung", payDeposit: "Anzahlung zahlen", total: "Gesamt", dueNow: "Jetzt fällig",
      days: "Tage", nameEmailRequired: "Name und E-Mail sind erforderlich.", answerRequired: "Bitte beantworten: ",
      slotTaken: "Dieser Termin wurde gerade vergeben. Wähle einen anderen.", confirmed: "Buchung bestätigt", confirmationSent: "Eine Bestätigung wurde gesendet an ",
      manageLink: "Diese Buchung verschieben oder stornieren", redirecting: "Weiter zur sicheren Zahlung…", waitlistTitle: "Auf die Warteliste",
      waitlistJoined: "Du stehst auf der Warteliste. Wir melden uns, wenn ein Platz frei wird.", genericError: "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
      allDay: "Ganztägig", free: "Kostenlos",
    },
  };

  function proxyUrl(path) {
    return "/apps/booking" + path;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function getJSON(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "error");
        return d;
      });
    });
  }

  function postJSON(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().then(function (d) {
        return { ok: r.ok, status: r.status, data: d };
      });
    });
  }

  // ---- date helpers on "YYYY-MM-DD" strings (no timezone math needed) ----
  function ymd(y, m, d) {
    return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  }
  function addDays(s, n) {
    var p = s.split("-").map(Number);
    return ymd(p[0], p[1] - 1, p[2] + n);
  }
  function diffDays(a, b) {
    var pa = a.split("-").map(Number), pb = b.split("-").map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }

  function signaturePad(canvas) {
    var ctx = canvas.getContext("2d");
    var ratio = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 400;
    var h = canvas.clientHeight || 140;
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1f1d36";
    var drawing = false;
    var pad = { dirty: false, clear: null, data: null };
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    canvas.addEventListener("pointerdown", function (e) {
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      var p = pos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      var p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      pad.dirty = true;
      e.preventDefault();
    });
    function end() {
      drawing = false;
    }
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.style.touchAction = "none";
    pad.clear = function () {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      pad.dirty = false;
    };
    pad.data = function () {
      return canvas.toDataURL("image/png");
    };
    return pad;
  }

  function init(root) {
    if (root.dataset.bwReady) return;
    root.dataset.bwReady = "1";
    root.classList.add("bookwell-widget");
    var serviceId = root.dataset.serviceId;
    if (!serviceId) return;
    if (root.dataset.accent) root.style.setProperty("--bw-accent", root.dataset.accent);

    var t = EN;
    var dateLocale = document.documentElement.lang || undefined;
    var cfg = null;
    var st = {
      staffId: "any",
      quantity: 1,
      addons: [],
      month: null,
      date: null,
      endDate: null,
      slot: null,
      repeat: 0,
      repeatCount: 4,
      days: {},
      basket: [],
      usePackage: false,
    };

    var autoOpen = root.dataset.open === "true";
    root.innerHTML = '<button class="bw-book-btn" type="button">' + esc(EN.bookBtn) + '</button><div class="bw-panel" style="display:none"></div>';
    var button = root.querySelector(".bw-book-btn");
    var panel = root.querySelector(".bw-panel");

    function log() {
      if (cfg && !cfg.hideLogs && window.console) console.log.apply(console, ["[Bookwell]"].concat([].slice.call(arguments)));
    }

    function money(n) {
      try {
        return new Intl.NumberFormat(dateLocale, { style: "currency", currency: (cfg && cfg.currency) || "USD" }).format(n);
      } catch (e) {
        return "$" + Number(n).toFixed(2);
      }
    }

    function applyConfig(c) {
      cfg = c;
      var stored = root.dataset.lang || document.documentElement.lang || c.defaultLanguage || "en";
      var lang = c.multiLanguage ? stored.slice(0, 2).toLowerCase() : c.defaultLanguage;
      var custom = (c.text && (c.text[lang] || c.text[c.defaultLang])) || {};
      t = Object.assign({}, EN, TR[lang] || {}, custom);
      if (c.design) {
        if (!root.dataset.accent && c.design.accent) root.style.setProperty("--bw-accent", c.design.accent);
        if (c.design.radius != null) root.style.setProperty("--bw-radius", c.design.radius + "px");
      }
      button.textContent = (c.design && c.design.buttonText) || t.bookBtn;
      if (c.staff && c.staff.length === 1) st.staffId = c.staff[0].id;
    }

    function load() {
      panel.innerHTML = '<p class="bw-loading">' + esc(t.loading) + "</p>";
      return getJSON(proxyUrl("/config?serviceId=" + encodeURIComponent(serviceId)))
        .then(function (c) {
          applyConfig(c);
          var today = new Date().toLocaleDateString("en-CA", { timeZone: c.timezone });
          st.today = today;
          st.month = today.slice(0, 7);
          var pre = root.dataset.date;
          if (pre && /^\d{4}-\d{2}-\d{2}$/.test(pre) && pre >= today) {
            st.month = pre.slice(0, 7);
            if (c.service.type !== "multiday") st.date = pre;
          }
          render();
        })
        .catch(function (e) {
          panel.innerHTML = '<p class="bw-loading">' + esc(t.unavailable) + "</p>";
          if (window.console) console.warn("[Bookwell]", e);
        });
    }

    button.addEventListener("click", function () {
      var open = panel.style.display === "none";
      panel.style.display = open ? "block" : "none";
      if (open && !cfg) load();
    });

    // ----------------------------------------------------------------
    function render() {
      var s = cfg.service;
      var html = '<div class="bw-head"><h3>' + esc(s.name) + "</h3>";
      var meta = [];
      if (!s.dayBased) meta.push(s.durationMinutes + " " + t.min);
      if (s.virtual) meta.push(t.online);
      meta.push(s.price > 0 ? money(s.price) + (s.type === "multiday" ? " / " + t.days.replace(/s$/, "") : "") : t.free);
      html += '<div class="bw-meta">' + esc(meta.join(" · ")) + "</div>";
      if (s.description) html += '<p class="bw-desc">' + esc(s.description) + "</p>";
      html += "</div>";

      if (s.maxQuantity > 1) {
        html += '<div class="bw-step"><span class="bw-label">' + esc(t.quantity) + '</span><div class="bw-qty"><button type="button" data-q="-1">−</button><span>' + st.quantity + '</span><button type="button" data-q="1">+</button></div></div>';
      }

      if (s.staffMode === "staff" && cfg.showStaffSelector && cfg.staff.length > 1) {
        html += '<div class="bw-step"><span class="bw-label">' + esc(t.pickStaff) + '</span><div class="bw-chips">';
        html += '<button type="button" class="bw-chip' + (st.staffId === "any" ? " on" : "") + '" data-staff="any">' + esc(t.anyStaff) + "</button>";
        cfg.staff.forEach(function (m) {
          html += '<button type="button" class="bw-chip' + (st.staffId === m.id ? " on" : "") + '" data-staff="' + esc(m.id) + '">' + esc(m.name) + (m.bio ? "<small>" + esc(m.bio) + "</small>" : "") + "</button>";
        });
        html += "</div></div>";
      }

      if (s.addons.length) {
        html += '<div class="bw-step"><span class="bw-label">' + esc(t.addons) + '</span><div class="bw-chips">';
        s.addons.forEach(function (a) {
          var on = st.addons.indexOf(a.id) >= 0;
          html += '<button type="button" class="bw-chip' + (on ? " on" : "") + '" data-addon="' + esc(a.id) + '">' + esc(a.name) + "<small>+" + esc(money(a.price)) + (a.durationMinutes ? " · +" + a.durationMinutes + " " + t.min : "") + "</small></button>";
        });
        html += "</div></div>";
      }

      html += '<div class="bw-step bw-cal-wrap"></div><div class="bw-step bw-times-wrap"></div><div class="bw-form-wrap"></div>';
      panel.innerHTML = html;

      panel.querySelectorAll("[data-q]").forEach(function (b) {
        b.addEventListener("click", function () {
          var max = Math.min(s.maxQuantity, s.capacity || s.maxQuantity);
          st.quantity = Math.max(1, Math.min(max, st.quantity + Number(b.dataset.q)));
          st.slot = null;
          render();
        });
      });
      panel.querySelectorAll("[data-staff]").forEach(function (b) {
        b.addEventListener("click", function () {
          st.staffId = b.dataset.staff;
          st.slot = null;
          st.days = {};
          render();
        });
      });
      panel.querySelectorAll("[data-addon]").forEach(function (b) {
        b.addEventListener("click", function () {
          var i = st.addons.indexOf(b.dataset.addon);
          if (i >= 0) st.addons.splice(i, 1);
          else st.addons.push(b.dataset.addon);
          st.slot = null;
          render();
        });
      });

      renderCalendar();
      if (st.date && !s.dayBased) loadTimes();
      if (s.dayBased && st.date && (s.type === "fullday" || st.endDate)) renderForm();
    }

    function monthKey() {
      return st.staffId + "|" + st.quantity + "|" + st.month;
    }

    function renderCalendar() {
      var wrap = panel.querySelector(".bw-cal-wrap");
      var s = cfg.service;
      var parts = st.month.split("-").map(Number);
      var first = ymd(parts[0], parts[1] - 1, 1);
      var nextMonth = ymd(parts[0], parts[1], 1);
      var last = addDays(nextMonth, -1);
      var title = new Date(Date.UTC(parts[0], parts[1] - 1, 1)).toLocaleDateString(dateLocale, { month: "long", year: "numeric", timeZone: "UTC" });
      var label = s.type === "multiday" ? (st.date && !st.endDate ? t.pickEnd : t.pickStart) : t.pickDate;
      var canPrev = first > st.today;
      var maxDate = addDays(st.today, s.maxAdvanceDays || 60);
      var canNext = nextMonth <= maxDate;

      var html = '<span class="bw-label">' + esc(label) + '</span><div class="bw-cal-head"><button type="button" class="bw-nav-btn" data-m="-1"' + (canPrev ? "" : " disabled") + '>‹</button><b>' + esc(title) + '</b><button type="button" class="bw-nav-btn" data-m="1"' + (canNext ? "" : " disabled") + ">›</button></div>";
      html += '<div class="bw-cal">';
      var start = cfg.weekStartsOn === 0 ? 0 : 1;
      for (var i = 0; i < 7; i++) {
        var dow = new Date(Date.UTC(2023, 0, 1 + ((start + i) % 7))).toLocaleDateString(dateLocale, { weekday: "short", timeZone: "UTC" });
        html += '<div class="dow">' + esc(dow.slice(0, 2)) + "</div>";
      }
      var firstDow = new Date(first + "T00:00:00Z").getUTCDay();
      var blanks = (firstDow - start + 7) % 7;
      for (var b = 0; b < blanks; b++) html += '<span class="bw-day blank"></span>';
      var known = st.days[monthKey()];
      for (var d = first; d <= last; d = addDays(d, 1)) {
        var open = known ? known[d] : false;
        var cls = "bw-day";
        if (open) cls += " open";
        if (d === st.today) cls += " today";
        if (d === st.date) cls += " sel";
        if (st.endDate && d === st.endDate) cls += " range-end";
        if (st.date && st.endDate && d > st.date && d < st.endDate) cls += " in-range";
        html += '<button type="button" class="' + cls + '" data-d="' + d + '"' + (open ? "" : " disabled") + ">" + Number(d.slice(8)) + "</button>";
      }
      html += "</div>";
      if (!known) html += '<p class="bw-loading">' + esc(t.loading) + "</p>";
      wrap.innerHTML = html;

      wrap.querySelectorAll("[data-m]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var p = st.month.split("-").map(Number);
          st.month = ymd(p[0], p[1] - 1 + Number(btn.dataset.m), 1).slice(0, 7);
          renderCalendar();
        });
      });
      wrap.querySelectorAll(".bw-day.open").forEach(function (btn) {
        btn.addEventListener("click", function () {
          pickDate(btn.dataset.d);
        });
      });

      if (!known) {
        var key = monthKey();
        var from = first < st.today ? st.today : first;
        getJSON(
          proxyUrl(
            "/availability?serviceId=" + encodeURIComponent(serviceId) +
              "&staffId=" + encodeURIComponent(st.staffId) +
              "&quantity=" + st.quantity +
              "&from=" + from + "&to=" + last,
          ),
        )
          .then(function (data) {
            var map = {};
            (data.days || []).forEach(function (x) {
              map[x.date] = x.available;
            });
            st.days[key] = map;
            if (monthKey() === key) renderCalendar();
          })
          .catch(function (e) {
            log(e);
            st.days[key] = {};
            if (monthKey() === key) renderCalendar();
          });
      }
    }

    function pickDate(d) {
      var s = cfg.service;
      st.slot = null;
      if (s.type === "multiday") {
        if (!st.date || st.endDate || d < st.date) {
          // Pick the same day again to book a single day.
          st.date = d;
          st.endDate = null;
        } else {
          var len = diffDays(st.date, d) + 1;
          if (len < s.minDays || len > s.maxDays) {
            st.date = d;
            st.endDate = null;
          } else {
            st.endDate = d;
          }
        }
        renderCalendar();
        var fw = panel.querySelector(".bw-form-wrap");
        if (st.endDate) renderForm();
        else fw.innerHTML = "";
        return;
      }
      st.date = d;
      renderCalendar();
      if (s.dayBased) renderForm();
      else loadTimes();
    }

    function loadTimes() {
      var wrap = panel.querySelector(".bw-times-wrap");
      wrap.innerHTML = '<p class="bw-loading">' + esc(t.loading) + "</p>";
      if (!st.basket.length) panel.querySelector(".bw-form-wrap").innerHTML = "";
      var date = st.date;
      getJSON(
        proxyUrl(
          "/availability?serviceId=" + encodeURIComponent(serviceId) +
            "&staffId=" + encodeURIComponent(st.staffId) +
            "&quantity=" + st.quantity +
            "&addons=" + encodeURIComponent(st.addons.join(",")) +
            "&date=" + date,
        ),
      )
        .then(function (data) {
          if (st.date !== date) return;
          var slots = data.slots || [];
          if (!slots.length) {
            wrap.innerHTML = '<p class="bw-loading">' + esc(t.noTimes) + "</p>";
            return;
          }
          var s = cfg.service;
          var html = '<span class="bw-label">' + esc(t.pickTime) + "</span>" +
            (s.allowMultiSlot ? '<p class="bw-hint" style="margin:-4px 0 8px">' + esc(t.pickUpTo.replace("{n}", s.maxSlots || 5)) + "</p>" : "") +
            '<div class="bw-times">';
          slots.forEach(function (slot, i) {
            var time = new Date(slot.startsAt).toLocaleTimeString(dateLocale, { hour: "numeric", minute: "2-digit", hour12: !cfg.use24h, timeZone: cfg.timezone });
            var showLeft = cfg.showSlotsLeft && s.capacity > 1 && slot.available && slot.seatsLeft < 1000;
            var picked = s.allowMultiSlot
              ? st.basket.some(function (b) { return b.startsAt === slot.startsAt; })
              : st.slot && st.slot.startsAt === slot.startsAt;
            var cls = "bw-time" + (slot.available ? "" : " full" + (s.waitlistEnabled ? " wait" : "")) + (picked ? " on" : "");
            var badge = slot.available ? (showLeft ? "<small>" + slot.seatsLeft + " " + esc(t.left) + "</small>" : "") : s.waitlistEnabled ? "<small>" + esc(t.joinWaitlist) + "</small>" : "";
            html += '<button type="button" class="' + cls + '" data-i="' + i + '"' + (!slot.available && !s.waitlistEnabled ? " disabled" : "") + "><span>" + esc(time) + "</span>" + badge + "</button>";
          });
          html += "</div>";
          wrap.innerHTML = html;
          wrap.querySelectorAll(".bw-time").forEach(function (btn) {
            btn.addEventListener("click", function () {
              var slot = slots[Number(btn.dataset.i)];
              if (!slot.available) {
                renderWaitlist(slot);
                return;
              }
              if (s.allowMultiSlot) {
                var idx = -1;
                st.basket.forEach(function (b, j) {
                  if (b.startsAt === slot.startsAt) idx = j;
                });
                if (idx >= 0) st.basket.splice(idx, 1);
                else if (st.basket.length < (s.maxSlots || 5)) st.basket.push(slot);
                st.slot = st.basket[0] || null;
                btn.classList.toggle("on", idx < 0);
                if (st.basket.length) renderForm();
                else panel.querySelector(".bw-form-wrap").innerHTML = "";
                return;
              }
              st.slot = slot;
              wrap.querySelectorAll(".bw-time").forEach(function (x) {
                x.classList.remove("on");
              });
              btn.classList.add("on");
              renderForm();
            });
          });
        })
        .catch(function (e) {
          log(e);
          wrap.innerHTML = '<p class="bw-loading">' + esc(t.genericError) + "</p>";
        });
    }

    function priceSummary() {
      var s = cfg.service;
      var unit = s.price;
      s.addons.forEach(function (a) {
        if (st.addons.indexOf(a.id) >= 0) unit += a.price;
      });
      var days = s.type === "multiday" && st.date && st.endDate ? diffDays(st.date, st.endDate) + 1 : 1;
      var sessions = st.repeat ? st.repeatCount : cfg.service.allowMultiSlot && st.basket.length ? st.basket.length : 1;
      var total = Math.round(unit * st.quantity * days * 100) / 100;
      var due = 0;
      if (s.paymentMode === "full") due = total;
      else if (s.paymentMode === "deposit_percent") due = Math.round(total * s.depositValue) / 100;
      else if (s.paymentMode === "deposit_fixed") due = Math.min(total, s.depositValue);
      return { total: total * sessions, due: due * sessions, days: days, sessions: sessions };
    }

    function renderForm() {
      var s = cfg.service;
      var wrap = panel.querySelector(".bw-form-wrap");
      var p = priceSummary();
      var html = '<div class="bw-form">';

      if (s.allowMultiSlot && st.basket.length) {
        html += '<div class="bw-summary"><b>' + esc(t.selectedTimes) + "</b>";
        st.basket.forEach(function (b, j) {
          var label = new Date(b.startsAt).toLocaleString(dateLocale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: !cfg.use24h, timeZone: cfg.timezone });
          html += '<div class="row"><span>' + esc(label) + '</span><button type="button" class="bw-chip" style="padding:2px 8px" data-rm="' + j + '">' + esc(t.remove) + "</button></div>";
        });
        html += "</div>";
      }

      if (s.allowRecurring && !s.dayBased && !s.allowMultiSlot) {
        html += '<div class="bw-q"><label>' + esc(t.repeat) + '</label><div style="display:flex;gap:8px"><select class="bw-repeat">' +
          '<option value="0">' + esc(t.repeatNone) + '</option><option value="7">' + esc(t.repeatWeekly) + '</option><option value="14">' + esc(t.repeat2) + '</option><option value="28">' + esc(t.repeat4) + "</option></select>" +
          '<select class="bw-repeat-count"' + (st.repeat ? "" : ' style="display:none"') + ">";
        for (var n = 2; n <= (s.maxRecurrences || 8); n++) html += '<option value="' + n + '"' + (n === st.repeatCount ? " selected" : "") + ">" + n + " " + esc(t.sessions) + "</option>";
        html += "</select></div></div>";
      }

      html += '<input type="text" class="bw-name" autocomplete="name" placeholder="' + esc(t.namePlaceholder) + '">';
      html += '<input type="email" class="bw-email" autocomplete="email" placeholder="' + esc(t.emailPlaceholder) + '">';
      html += '<input type="tel" class="bw-phone" autocomplete="tel" placeholder="' + esc(t.phonePlaceholder) + '">';
      if (cfg.smsAvailable) html += '<label class="bw-check"><input type="checkbox" class="bw-sms"> ' + esc(t.smsOptIn) + "</label>";
      if (cfg.packagesAvailable) {
        html += '<label class="bw-check"><input type="checkbox" class="bw-pkg"' + (st.usePackage ? " checked" : "") + "> " + esc(t.usePackage) +
          ' <a href="/apps/booking/packages" style="margin-left:auto;color:var(--bw-accent);font-size:12px">' + esc(t.buyPackage) + "</a></label>";
      }

      cfg.questions.forEach(function (q) {
        var id = "bwq-" + q.id;
        var label = esc(q.label) + (q.required ? " *" : "");
        if (q.type === "checkbox") {
          html += '<label class="bw-check"><input type="checkbox" data-qid="' + esc(q.id) + '"> ' + label + "</label>";
        } else if (q.type === "select") {
          html += '<div class="bw-q"><label for="' + id + '">' + label + '</label><select id="' + id + '" data-qid="' + esc(q.id) + '"><option value=""></option>';
          q.options.forEach(function (o) {
            html += '<option value="' + esc(o) + '">' + esc(o) + "</option>";
          });
          html += "</select></div>";
        } else if (q.type === "textarea") {
          html += '<div class="bw-q"><label for="' + id + '">' + label + '</label><textarea id="' + id + '" data-qid="' + esc(q.id) + '"></textarea></div>';
        } else {
          html += '<div class="bw-q"><label for="' + id + '">' + label + '</label><input type="text" id="' + id + '" data-qid="' + esc(q.id) + '"></div>';
        }
      });

      if (cfg.waiver) {
        html += '<div class="bw-waiver"><span class="bw-label">' + esc(cfg.waiver.title) + "</span>" +
          '<div class="bw-waiver-text">' + esc(cfg.waiver.body) + "</div>" +
          '<label class="bw-check"><input type="checkbox" class="bw-waiver-agree"> ' + esc(t.waiverAgree) + "</label>" +
          '<input type="text" class="bw-waiver-name" placeholder="' + esc(t.waiverName) + '">' +
          '<div class="bw-sig-wrap"><canvas class="bw-sig" aria-label="' + esc(t.waiverSign) + '"></canvas><span class="bw-sig-hint">' + esc(t.waiverSign) + '</span>' +
          '<button type="button" class="bw-sig-clear">' + esc(t.waiverClear) + "</button></div></div>";
      }

      if (p.total > 0) {
        html += '<div class="bw-summary">';
        if (p.days > 1) html += '<div class="row"><span>' + p.days + " " + esc(t.days) + "</span><span></span></div>";
        if (p.sessions > 1) html += '<div class="row"><span>' + p.sessions + " " + esc(t.sessions) + "</span><span></span></div>";
        html += '<div class="row total"><span>' + esc(t.total) + "</span><span>" + esc(money(p.total)) + "</span></div>";
        if (p.due > 0 && p.due < p.total) html += '<div class="row"><span>' + esc(t.dueNow) + "</span><span>" + esc(money(p.due)) + "</span></div>";
        html += "</div>";
      }

      if (st.usePackage) p.due = 0;
      var cta = p.due > 0 ? (p.due < p.total ? t.payDeposit + " · " + money(p.due) : t.payBtn + " · " + money(p.due)) : t.confirmBtn;
      html += '<button type="button" class="bw-book-btn bw-confirm">' + esc(cta) + '</button><div class="bw-error" role="alert"></div></div>';
      wrap.innerHTML = html;

      var rep = wrap.querySelector(".bw-repeat");
      if (rep) {
        rep.value = String(st.repeat);
        rep.addEventListener("change", function () {
          st.repeat = Number(rep.value);
          renderForm();
        });
        wrap.querySelector(".bw-repeat-count").addEventListener("change", function (e) {
          st.repeatCount = Number(e.target.value);
          renderForm();
        });
      }
      wrap.querySelector(".bw-confirm").addEventListener("click", confirmBooking);
      var sigCanvas = wrap.querySelector(".bw-sig");
      st.pad = sigCanvas ? signaturePad(sigCanvas) : null;
      var clearBtn = wrap.querySelector(".bw-sig-clear");
      if (clearBtn && st.pad) clearBtn.addEventListener("click", function () { st.pad.clear(); });
      wrap.querySelectorAll("[data-rm]").forEach(function (b) {
        b.addEventListener("click", function () {
          st.basket.splice(Number(b.dataset.rm), 1);
          st.slot = st.basket[0] || null;
          if (st.date) loadTimes();
          if (st.basket.length) renderForm();
          else wrap.innerHTML = "";
        });
      });
      var pkg = wrap.querySelector(".bw-pkg");
      if (pkg) {
        pkg.addEventListener("change", function () {
          // Keep what the customer typed while the button label updates.
          var keep = {};
          wrap.querySelectorAll("input[type=text],input[type=email],input[type=tel]").forEach(function (i) { keep[i.className] = i.value; });
          st.usePackage = pkg.checked;
          renderForm();
          Object.keys(keep).forEach(function (k) { var i = wrap.querySelector("." + k.split(" ")[0]); if (i) i.value = keep[k]; });
        });
      }
      var name = wrap.querySelector(".bw-name");
      if (name && name.scrollIntoView) name.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function collect(errorEl) {
      var name = panel.querySelector(".bw-name").value.trim();
      var email = panel.querySelector(".bw-email").value.trim();
      if (!name || !email) {
        errorEl.textContent = t.nameEmailRequired;
        return null;
      }
      var answers = {};
      for (var i = 0; i < cfg.questions.length; i++) {
        var q = cfg.questions[i];
        var el = panel.querySelector('[data-qid="' + q.id + '"]');
        var v = el ? (q.type === "checkbox" ? el.checked : el.value.trim()) : "";
        if (q.required && !v) {
          errorEl.textContent = t.answerRequired + q.label;
          return null;
        }
        answers[q.id] = v;
      }
      var sms = panel.querySelector(".bw-sms");
      return {
        customerName: name,
        customerEmail: email,
        customerPhone: panel.querySelector(".bw-phone").value.trim(),
        smsOptIn: Boolean(sms && sms.checked),
        answers: answers,
      };
    }

    function confirmBooking() {
      var errorEl = panel.querySelector(".bw-error");
      errorEl.textContent = "";
      var who = collect(errorEl);
      if (!who) return;
      var s = cfg.service;
      var btn = panel.querySelector(".bw-confirm");
      btn.disabled = true;

      var body = Object.assign(who, {
        serviceId: serviceId,
        staffId: st.slot && st.slot.staffId ? st.slot.staffId : st.staffId,
        quantity: st.quantity,
        addons: st.addons,
      });
      if (s.dayBased) {
        body.date = st.date;
        if (s.type === "multiday") body.endDate = st.endDate;
      } else if (s.allowMultiSlot && st.basket.length) {
        body.startsAt = st.basket[0].startsAt;
        body.startsAtList = st.basket.map(function (b) { return b.startsAt; });
        body.staffId = st.staffId;
      } else {
        body.startsAt = st.slot.startsAt;
      }
      if (st.repeat && !s.allowMultiSlot) body.recurrence = { count: st.repeatCount, intervalDays: st.repeat };
      if (st.usePackage) body.usePackage = true;
      if (cfg.waiver) {
        var agree = panel.querySelector(".bw-waiver-agree");
        var sigName = panel.querySelector(".bw-waiver-name");
        if (!agree || !agree.checked || !sigName || !sigName.value.trim() || !st.pad || !st.pad.dirty) {
          btn.disabled = false;
          errorEl.textContent = t.waiverRequired;
          return;
        }
        body.waiver = { agreed: true, name: sigName.value.trim(), signature: st.pad.data() };
      }

      postJSON(proxyUrl("/bookings"), body)
        .then(function (res) {
          if (!res.ok) {
            btn.disabled = false;
            errorEl.textContent = res.data.error || t.slotTaken;
            if (res.status === 409) {
              st.days = {};
              if (s.dayBased) renderCalendar();
              else loadTimes();
            }
            return;
          }
          track(res.data.booking);
          if (res.data.checkoutUrl) {
            panel.innerHTML = '<div class="bw-success"><p class="bw-sub">' + esc(t.redirecting) + "</p></div>";
            window.location.href = res.data.checkoutUrl;
            return;
          }
          var token = res.data.booking && res.data.booking.manageToken;
          panel.innerHTML =
            '<div class="bw-success"><div class="bw-ring"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
            "<h4>" + esc(t.confirmed) + "</h4>" +
            '<p class="bw-sub">' + esc(t.confirmationSent) + esc(who.customerEmail) + ".</p>" +
            (token ? '<a href="' + proxyUrl("/manage?token=" + encodeURIComponent(token)) + '">' + esc(t.manageLink) + "</a>" : "") +
            "</div>";
        })
        .catch(function (e) {
          log(e);
          btn.disabled = false;
          errorEl.textContent = t.genericError;
        });
    }

    function renderWaitlist(slot) {
      var wrap = panel.querySelector(".bw-form-wrap");
      wrap.innerHTML =
        '<div class="bw-form"><span class="bw-label">' + esc(t.waitlistTitle) + "</span>" +
        '<input type="text" class="bw-name" placeholder="' + esc(t.namePlaceholder) + '">' +
        '<input type="email" class="bw-email" placeholder="' + esc(t.emailPlaceholder) + '">' +
        '<input type="tel" class="bw-phone" placeholder="' + esc(t.phonePlaceholder) + '">' +
        '<button type="button" class="bw-book-btn bw-join">' + esc(t.joinWaitlist) + '</button><div class="bw-error" role="alert"></div></div>';
      wrap.querySelector(".bw-join").addEventListener("click", function () {
        var errorEl = wrap.querySelector(".bw-error");
        var name = wrap.querySelector(".bw-name").value.trim();
        var email = wrap.querySelector(".bw-email").value.trim();
        if (!name || !email) {
          errorEl.textContent = t.nameEmailRequired;
          return;
        }
        postJSON(proxyUrl("/waitlist"), {
          serviceId: serviceId,
          staffId: st.staffId,
          date: st.date,
          startsAt: slot ? slot.startsAt : null,
          customerName: name,
          customerEmail: email,
          customerPhone: wrap.querySelector(".bw-phone").value.trim(),
        }).then(function (res) {
          if (!res.ok) {
            errorEl.textContent = res.data.error || t.genericError;
            return;
          }
          wrap.innerHTML = '<div class="bw-form"><p class="bw-sub">' + esc(t.waitlistJoined) + "</p></div>";
        });
      });
    }

    function track(booking) {
      try {
        var value = booking ? booking.totalPrice : 0;
        if (window.gtag) window.gtag("event", "bookwell_booking", { value: value, currency: cfg.currency, service: cfg.service.name });
        else if (cfg.tracking && cfg.tracking.ga) {
          var sc = document.createElement("script");
          sc.async = true;
          sc.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(cfg.tracking.ga);
          document.head.appendChild(sc);
          window.dataLayer = window.dataLayer || [];
          window.gtag = function () {
            window.dataLayer.push(arguments);
          };
          window.gtag("js", new Date());
          window.gtag("config", cfg.tracking.ga);
          window.gtag("event", "bookwell_booking", { value: value, currency: cfg.currency });
        }
        if (window.fbq) window.fbq("track", "Schedule", { value: value, currency: cfg.currency });
      } catch (e) {
        log(e);
      }
    }

    if (autoOpen) {
      panel.style.display = "block";
      button.style.display = "none";
      load();
    } else {
      // Fetch the config early so the button shows the merchant's label.
      getJSON(proxyUrl("/config?serviceId=" + encodeURIComponent(serviceId)))
        .then(function (c) {
          if (cfg) return;
          applyConfig(c);
          var today = new Date().toLocaleDateString("en-CA", { timeZone: c.timezone });
          st.today = today;
          st.month = today.slice(0, 7);
          if (panel.style.display !== "none") render();
        })
        .catch(function () {});
      button.addEventListener("click", function () {
        if (cfg && !panel.querySelector(".bw-head")) render();
      });
    }
  }

  function boot() {
    var nodes = document.querySelectorAll(".bookwell-widget[data-service-id], #bookwell-widget[data-service-id]");
    for (var i = 0; i < nodes.length; i++) init(nodes[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Lets the floating button (app embed) mount a widget it creates later.
  window.Bookwell = { mount: init, boot: boot };
})();
