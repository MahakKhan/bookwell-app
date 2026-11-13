import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getShop } from "../models/shop.server";
import { formatBookingWhen } from "../models/lifecycle.server";
import { addDays, localParts, zonedToUtc } from "../models/time.server";
import { Flash, STATUS_BADGE, STATUS_LABEL } from "../components/ui";

// Check-in: scan a ticket QR ("BW:<manageToken>") with the device camera, or
// type the code, then mark the guest as arrived.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const today = localParts(new Date(), shop.timezone).dateStr;
  const bookings = await prisma.booking.findMany({
    where: {
      shopId: shop.id,
      status: { in: ["confirmed", "completed"] },
      startsAt: { lt: zonedToUtc(addDays(today, 1), 0, shop.timezone) },
      endsAt: { gt: zonedToUtc(today, 0, shop.timezone) },
    },
    include: { service: { select: { name: true, type: true } } },
    orderBy: { startsAt: "asc" },
    take: 300,
  });
  return json({
    today,
    rows: bookings.map((b) => ({
      id: b.id,
      when: formatBookingWhen(shop, b, b.service),
      service: b.service.name,
      customer: b.customerName,
      quantity: b.quantity,
      status: b.status,
      checkedIn: b.checkedInAt ? b.checkedInAt.toISOString() : null,
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const raw = String(form.get("code") || "").trim().replace(/^BW:/i, "");
  const id = String(form.get("id") || "");

  const booking = await prisma.booking.findFirst({
    where: { shopId: shop.id, ...(id ? { id } : { OR: [{ manageToken: raw }, { id: raw }] }) },
    include: { service: { select: { name: true, type: true } } },
  });
  if (!booking) return json({ error: "No booking matches that code." }, { status: 404 });
  const info = {
    id: booking.id,
    when: formatBookingWhen(shop, booking, booking.service),
    service: booking.service.name,
    customer: booking.customerName,
    quantity: booking.quantity,
    status: booking.status,
    checkedIn: booking.checkedInAt?.toISOString() ?? null,
  };

  if (intent === "lookup") return json({ found: info });
  if (intent === "checkin") {
    if (!["confirmed", "completed"].includes(booking.status)) {
      return json({ error: `This booking is ${STATUS_LABEL[booking.status]?.toLowerCase() ?? booking.status} and can't be checked in.`, found: info }, { status: 400 });
    }
    if (booking.checkedInAt) return json({ warning: `Already checked in at ${booking.checkedInAt.toLocaleTimeString()}.`, found: info });
    await prisma.booking.update({ where: { id: booking.id }, data: { checkedInAt: new Date(), status: "completed" } });
    return json({ ok: `${booking.customerName} checked in${booking.quantity > 1 ? ` (${booking.quantity} people)` : ""}.` });
  }
  if (intent === "undo") {
    await prisma.booking.update({ where: { id: booking.id }, data: { checkedInAt: null, status: "confirmed" } });
    return json({ ok: "Check-in undone." });
  }
  return json({ error: "Unknown action." }, { status: 400 });
}

declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
  }
}

export default function CheckIn() {
  const { rows, today } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const found = actionData && "found" in actionData ? actionData.found : null;

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setScanError("This browser can't open the camera. Type the code instead.");
        setScanning(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        setScanError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera access was blocked. Allow the camera for this site in your browser's address bar, or type the code."
            : name === "NotFoundError"
              ? "No camera was found on this device. Type the code instead."
              : "The camera couldn't start. Type the code instead.",
        );
        setScanning(false);
        return;
      }
      if (!video.current) return;
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});

      // Built-in detector where the browser has one (Chrome on Mac/Android);
      // otherwise decode frames ourselves (Windows, Firefox, Safari).
      const native = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
      const jsQR = native ? null : (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      while (!stop) {
        let found: string | null = null;
        const v = video.current;
        if (v && v.readyState >= 2) {
          if (native) {
            const codes = await native.detect(v).catch(() => []);
            found = codes[0]?.rawValue ?? null;
          } else if (jsQR && ctx && v.videoWidth) {
            const w = Math.min(640, v.videoWidth);
            const h = Math.round((v.videoHeight / v.videoWidth) * w);
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(v, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            found = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" })?.data ?? null;
          }
        }
        if (found) {
          submit({ intent: "lookup", code: found }, { method: "post" });
          setScanning(false);
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning, submit]);

  return (
    <div>
      <div className="bw-head">
        <div>
          <h1>Check-in</h1>
          <p className="bw-sub">Scan the QR code from the customer's confirmation email or manage page.</p>
        </div>
      </div>
      <Flash data={actionData} />
      {scanError && <div className="bw-alert warn">{scanError}</div>}

      <div className="bw-dash-grid">
        <div className="bw-card bw-section bw-stack">
          <div className="bw-row">
            <button type="button" className="bw-btn primary" onClick={() => (setScanError(""), setScanning(!scanning))}>
              {scanning ? "Stop camera" : "Scan with camera"}
            </button>
          </div>
          {scanning && <video ref={video} muted playsInline style={{ width: "100%", maxWidth: 420, borderRadius: 12, background: "#000" }} />}
          <Form method="post" className="bw-row">
            <input type="hidden" name="intent" value="lookup" />
            <input name="code" className="bw-input" style={{ maxWidth: 340 }} placeholder="Ticket code or booking ID" autoFocus />
            <button className="bw-btn">Find</button>
          </Form>
          {found && (
            <div className="bw-card bw-pad">
              <dl className="bw-kv">
                <dt>Customer</dt>
                <dd>{found.customer}</dd>
                <dt>Service</dt>
                <dd>{found.service}</dd>
                <dt>When</dt>
                <dd>{found.when}</dd>
                <dt>People</dt>
                <dd>{found.quantity}</dd>
                <dt>Status</dt>
                <dd>
                  <span className={`bw-badge ${STATUS_BADGE[found.status] ?? ""}`}>{STATUS_LABEL[found.status] ?? found.status}</span>
                  {found.checkedIn ? <span className="bw-badge green" style={{ marginLeft: 6 }}>Checked in</span> : null}
                </dd>
              </dl>
              {!found.checkedIn && (
                <Form method="post" style={{ marginTop: 12 }}>
                  <input type="hidden" name="intent" value="checkin" />
                  <input type="hidden" name="id" value={found.id} />
                  <button className="bw-btn primary">Check in</button>
                </Form>
              )}
            </div>
          )}
        </div>

        <div className="bw-card">
          <div className="bw-section" style={{ paddingBottom: 8 }}>
            <h2>Today · {today}</h2>
            <p className="bw-sub">
              {rows.filter((r) => r.checkedIn).length} of {rows.length} checked in
            </p>
          </div>
          {rows.length === 0 ? (
            <div className="bw-empty">Nothing booked today.</div>
          ) : (
            rows.map((r) => (
              <div className="bw-list-item" key={r.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{r.customer}</b>
                  <div className="bw-help">
                    {r.when} · {r.service}
                    {r.quantity > 1 ? ` · ${r.quantity} people` : ""}
                  </div>
                </div>
                <Form method="post">
                  <input type="hidden" name="intent" value={r.checkedIn ? "undo" : "checkin"} />
                  <input type="hidden" name="id" value={r.id} />
                  <button className={`bw-btn sm${r.checkedIn ? "" : " primary"}`}>{r.checkedIn ? "Undo" : "Check in"}</button>
                </Form>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
