export type PriceHistoryInput = {
  item_id: string
  item_name: string
  quantity: number
  purchase_cost: string
  total_cost: string | null
  purchase_date: string
}

export type PriceHistoryRow = {
  item_id: string
  item_name: string
  purchase_count: number
  total_qty: number
  total_spend: number
  avg_unit: number
  min_unit: number
  max_unit: number
  last_unit: number
  last_purchase: string
}

function parseMoney(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? "0")
  return Number.isFinite(parsed) ? parsed : 0
}

export function buildPriceHistory(purchases: PriceHistoryInput[]): PriceHistoryRow[] {
  const byItem = new Map<string, PriceHistoryRow>()

  for (const purchase of purchases) {
    const unit = parseMoney(purchase.purchase_cost)
    const qty = purchase.quantity
    const spend = parseMoney(purchase.total_cost) || unit * qty
    const existing = byItem.get(purchase.item_id)

    if (!existing) {
      byItem.set(purchase.item_id, {
        item_id: purchase.item_id,
        item_name: purchase.item_name,
        purchase_count: 1,
        total_qty: qty,
        total_spend: spend,
        avg_unit: unit,
        min_unit: unit,
        max_unit: unit,
        last_unit: unit,
        last_purchase: purchase.purchase_date,
      })
      continue
    }

    existing.purchase_count += 1
    existing.total_qty += qty
    existing.total_spend += spend
    existing.min_unit = Math.min(existing.min_unit, unit)
    existing.max_unit = Math.max(existing.max_unit, unit)

    if (new Date(purchase.purchase_date).getTime() > new Date(existing.last_purchase).getTime()) {
      existing.last_purchase = purchase.purchase_date
      existing.last_unit = unit
    }
  }

  const rows = Array.from(byItem.values()).map((row) => ({
    ...row,
    avg_unit: row.total_qty > 0 ? row.total_spend / row.total_qty : 0,
  }))

  rows.sort((a, b) => b.total_spend - a.total_spend)
  return rows
}
