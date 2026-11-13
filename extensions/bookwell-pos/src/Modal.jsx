import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Requests use a RELATIVE path: Shopify resolves it against the app's
// `application_url` (the dev tunnel during `shopify app dev`, the real host
// once deployed), so nothing here needs changing between environments.
// FALLBACK_URL is only tried if a relative request isn't supported.
const FALLBACK_URL = "https://bookwell-app.onrender.com";

async function call(path, init = {}) {
  const token = await shopify.session.getSessionToken();
  const opts = { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    res = null;
  }
  if (!res || !res.ok) res = await fetch(`${FALLBACK_URL}${path}`, opts);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n } = shopify;
  const [state, setState] = useState({ status: "loading", bookings: [], timezone: undefined });
  const [busy, setBusy] = useState(null);

  const load = async () => {
    try {
      const data = await call("/api/pos/bookings");
      setState({ status: "ready", bookings: data.bookings, timezone: data.timezone });
    } catch {
      setState({ status: "error", bookings: [], timezone: undefined });
    }
  };

  useEffect(() => {
    load();
  }, []);

  const checkIn = async (id) => {
    setBusy(id);
    try {
      await call("/api/pos/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "checkin", id }),
      });
      shopify.toast.show(i18n.translate("checked_in"));
      await load();
    } catch {
      shopify.toast.show(i18n.translate("error"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <s-page heading={i18n.translate("modal_heading")}>
      <s-scroll-box>
        {state.status === "loading" && (
          <s-box padding="small">
            <s-text>{i18n.translate("loading")}</s-text>
          </s-box>
        )}
        {state.status === "error" && (
          <s-box padding="small">
            <s-text>{i18n.translate("error")}</s-text>
          </s-box>
        )}
        {state.status === "ready" && state.bookings.length === 0 && (
          <s-box padding="small">
            <s-text>{i18n.translate("empty")}</s-text>
          </s-box>
        )}
        {state.status === "ready" &&
          state.bookings.map((b) => (
            <s-box key={b.id} padding="small">
              <s-text emphasis="bold">
                {new Date(b.startsAt).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: state.timezone,
                })}{" "}
                — {b.serviceName}
              </s-text>
              <s-text>
                {b.customerName}
                {b.staffName ? ` with ${b.staffName}` : ""}
                {b.quantity > 1 ? ` · ${b.quantity}` : ""}
              </s-text>
              {b.checkedIn ? (
                <s-text>{i18n.translate("checked_in")}</s-text>
              ) : (
                <s-button onClick={() => checkIn(b.id)} disabled={busy === b.id}>
                  {i18n.translate("check_in")}
                </s-button>
              )}
            </s-box>
          ))}
      </s-scroll-box>
    </s-page>
  );
}
