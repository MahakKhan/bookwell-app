import { widgetAsset } from "../models/widgetAssets.server";

// /apps/booking/widget.css (via the app proxy) — used by the standalone booking page.
export const loader = () => widgetAsset("booking.css", "text/css; charset=utf-8");
