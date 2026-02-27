export const PURCHASE_STATUSES = [
  "pending",
  "in_transit",
  "delivered",
  "returned",
  "damaged",
  "lost",
] as const

export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number]
