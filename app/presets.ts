// Service presets shown in "New service". Each one is just a starting set of
// field values — everything stays editable afterwards. Shared by client + server.

export type Preset = {
  key: string;
  icon: string;
  title: string;
  blurb: string;
  group: "basic" | "preset";
  values: Partial<{
    type: string;
    name: string;
    durationMinutes: number;
    price: number;
    capacity: number;
    maxQuantity: number;
    staffMode: string;
    paymentMode: string;
    depositValue: number;
    allowRecurring: boolean;
    maxRecurrences: number;
    minDays: number;
    maxDays: number;
    slotStepMinutes: number;
    bufferMinutes: number;
  }>;
};

export const PRESETS: Preset[] = [
  {
    key: "regular",
    icon: "🗓️",
    title: "Regular booking",
    blurb: "Date and time selection. One customer per slot.",
    group: "basic",
    values: { type: "appointment", name: "Appointment", durationMinutes: 60 },
  },
  {
    key: "multiday",
    icon: "📆",
    title: "Multi-day booking",
    blurb: "Customers pick a start and an end date for longer stays or rentals.",
    group: "basic",
    values: { type: "multiday", name: "Multi-day rental", staffMode: "none", minDays: 1, maxDays: 14 },
  },
  {
    key: "fullday",
    icon: "☀️",
    title: "Full-day booking",
    blurb: "Book entire days, no time slots.",
    group: "basic",
    values: { type: "fullday", name: "Full day", staffMode: "none", capacity: 1 },
  },
  {
    key: "packs",
    icon: "🔁",
    title: "Recurring / class pack",
    blurb: "Book the same time every week for several sessions in one go.",
    group: "basic",
    values: { type: "appointment", name: "Weekly sessions", durationMinutes: 60, allowRecurring: true, maxRecurrences: 8 },
  },
  {
    key: "appointments",
    icon: "💼",
    title: "Appointments",
    blurb: "Standard paid or free bookings for salons, coaching or medical.",
    group: "preset",
    values: { type: "appointment", name: "Consultation", durationMinutes: 30 },
  },
  {
    key: "virtual",
    icon: "💻",
    title: "Virtual appointment",
    blurb: "Online sessions; your Zoom or Google Meet link goes in the confirmation.",
    group: "preset",
    values: { type: "virtual", name: "Online session", durationMinutes: 45 },
  },
  {
    key: "spa",
    icon: "💆",
    title: "Spa & beauty",
    blurb: "Salons with several team members; customers choose who they want.",
    group: "preset",
    values: { type: "appointment", name: "Haircut & style", durationMinutes: 60, bufferMinutes: 10 },
  },
  {
    key: "group",
    icon: "👥",
    title: "Group booking",
    blurb: "Tours, classes or private events with a capacity limit.",
    group: "preset",
    values: { type: "group", name: "Guided tour", durationMinutes: 90, capacity: 10, maxQuantity: 6 },
  },
  {
    key: "workshop",
    icon: "🏺",
    title: "Workshop",
    blurb: "Sell seats for classes or workshops with limited capacity.",
    group: "preset",
    values: { type: "group", name: "Pottery workshop", durationMinutes: 120, capacity: 8, maxQuantity: 4 },
  },
  {
    key: "restaurant",
    icon: "🍽️",
    title: "Restaurant table",
    blurb: "Table reservations with an optional no-show deposit.",
    group: "preset",
    values: { type: "rental", name: "Dinner reservation", durationMinutes: 90, staffMode: "none", capacity: 10, maxQuantity: 8, slotStepMinutes: 30, paymentMode: "deposit_fixed", depositValue: 10 },
  },
  {
    key: "dayevent",
    icon: "🎟️",
    title: "Full-day event",
    blurb: "Single-day passes for museums, zoos or hiking trails.",
    group: "preset",
    values: { type: "fullday", name: "Day pass", staffMode: "none", capacity: 100, maxQuantity: 10 },
  },
  {
    key: "prepay",
    icon: "💳",
    title: "Service with prepayment",
    blurb: "Charge a percentage up front to secure the booking; the rest is paid later.",
    group: "preset",
    values: { type: "appointment", name: "Full service", durationMinutes: 90, price: 100, paymentMode: "deposit_percent", depositValue: 30 },
  },
  {
    key: "court",
    icon: "🎾",
    title: "Sport court rental",
    blurb: "Tennis, padel or squash courts by the hour.",
    group: "preset",
    values: { type: "rental", name: "Court booking", durationMinutes: 60, staffMode: "none", capacity: 2, slotStepMinutes: 60 },
  },
  {
    key: "equipment",
    icon: "🚲",
    title: "Equipment rental",
    blurb: "Cameras, bikes or skis by the day, limited by stock.",
    group: "preset",
    values: { type: "multiday", name: "Mountain bike", staffMode: "none", capacity: 5, maxQuantity: 3, minDays: 1, maxDays: 14 },
  },
  {
    key: "vehicle",
    icon: "🚗",
    title: "Car or boat rental",
    blurb: "Rent vehicles for days or weeks.",
    group: "preset",
    values: { type: "multiday", name: "Luxury sedan", staffMode: "none", capacity: 1, minDays: 1, maxDays: 30, paymentMode: "deposit_percent", depositValue: 20 },
  },
  {
    key: "property",
    icon: "🏡",
    title: "Property rental",
    blurb: "Nightly accommodation like a cabin or apartment.",
    group: "preset",
    values: { type: "multiday", name: "Lakeside cabin", staffMode: "none", capacity: 1, minDays: 2, maxDays: 30, paymentMode: "full" },
  },
  {
    key: "ticket",
    icon: "🎫",
    title: "Event with tickets",
    blurb: "Sell tickets for concerts, talks or parties.",
    group: "preset",
    values: { type: "event", name: "Live event", durationMinutes: 180, staffMode: "none", capacity: 50, maxQuantity: 10, paymentMode: "full" },
  },
];

export const TYPE_LABEL: Record<string, string> = {
  appointment: "Appointment",
  group: "Group",
  virtual: "Virtual",
  event: "Event",
  rental: "Rental",
  fullday: "Full day",
  multiday: "Multi-day",
};

export const PAYMENT_LABEL: Record<string, string> = {
  none: "Pay later / free",
  full: "Full prepayment",
  deposit_percent: "Deposit (%)",
  deposit_fixed: "Deposit (fixed)",
};
