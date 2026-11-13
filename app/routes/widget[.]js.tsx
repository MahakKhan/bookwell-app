import { widgetAsset } from "../models/widgetAssets.server";

// /apps/booking/widget.js (via the app proxy) — used by the standalone booking page.
export const loader = () => widgetAsset("booking.js", "application/javascript; charset=utf-8");
