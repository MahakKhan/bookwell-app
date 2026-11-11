import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// POS extensions can't read the Remix server's process.env, and the dev
// tunnel URL changes every `shopify app dev` restart — set this to your
// app's real URL once deployed (it matches `application_url` in
// shopify.app.toml). Left as the placeholder, every fetch below just
// fails quietly into the "couldn't load" state instead of crashing.
const APP_URL = "https://bookwell-app.onrender.com";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { i18n, session } = shopify;
  const [state, setState] = useState({ status: "loading", bookings: [] });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const token = await session.session.getSessionToken();
        const res = await fetch(`${APP_URL}/api/pos/bookings`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!cancelled) setState({ status: "ready", bookings: data.bookings });
      } catch {
        if (!cancelled) setState({ status: "error", bookings: [] });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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
                })}{" "}
                — {b.serviceName}
              </s-text>
              <s-text>
                {b.customerName} with {b.staffName}
              </s-text>
            </s-box>
          ))}
      </s-scroll-box>
    </s-page>
  );
}
