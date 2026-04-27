import type { PurchaseEconomics } from "../types"

export interface BonusAttributionResult {
  isAttributed: boolean
  label: string | null
  showDistributeAction: boolean
}

export interface BonusAttributionLine {
  parentItemName: string
  parentQty: number
  invoiceNumber: string
}

/** A display row — either a regular purchase or a collapsed group of attributed bonuses. */
export type DisplayRow =
  | { kind: "purchase"; purchase: PurchaseEconomics }
  | {
      kind: "bonus-group"
      /** The first purchase in the group (used for item link, price, status, etc.) */
      representative: PurchaseEconomics
      /** All underlying purchase IDs in this group */
      purchaseIds: string[]
      /** Summed quantity across all rows in the group */
      totalQty: number
      /** Summed line total (total_selling) */
      totalSelling: number
      /** Summed total_commission */
      totalCommission: number
      /** Per-parent attribution lines */
      attributions: BonusAttributionLine[]
    }

/**
 * Determine the attribution display state of a bonus purchase.
 *
 * Returns:
 *  - isAttributed: true when the bonus has a parent purchase link
 *  - label: the "↳ attributed to ..." display string, or null
 *  - showDistributeAction: true when the bonus needs distribution (unattributed)
 */
export function getBonusAttribution(p: Pick<
  PurchaseEconomics,
  "purchase_type" | "bonus_for_purchase_id" | "bonus_parent_item_name" | "bonus_parent_quantity" | "bonus_parent_invoice_number"
>): BonusAttributionResult {
  if (p.purchase_type !== "bonus") {
    return { isAttributed: false, label: null, showDistributeAction: false }
  }

  if (!p.bonus_for_purchase_id) {
    return { isAttributed: false, label: null, showDistributeAction: true }
  }

  // Attributed — parent info must come from the server
  if (p.bonus_parent_item_name) {
    return {
      isAttributed: true,
      label: `↳ attributed to ${p.bonus_parent_item_name} × ${p.bonus_parent_quantity} (inv #${p.bonus_parent_invoice_number})`,
      showDistributeAction: false,
    }
  }

  // Attributed but server didn't return parent info — data integrity issue
  return {
    isAttributed: true,
    label: `↳ attributed (parent details unavailable)`,
    showDistributeAction: false,
  }
}

/**
 * Count unattributed bonuses in a purchase list.
 */
export function countUnattributedBonuses(
  purchases: Pick<PurchaseEconomics, "purchase_type" | "bonus_for_purchase_id">[]
): number {
  return purchases.filter(
    (p) => p.purchase_type === "bonus" && !p.bonus_for_purchase_id
  ).length
}

/**
 * Build a display-row list from raw purchases.
 *
 * Attributed bonuses for the same item_id are collapsed into a single
 * "bonus-group" row. Everything else passes through as a "purchase" row.
 * Original ordering is preserved: the group appears at the position of
 * the first member encountered.
 */
export function buildDisplayRows(purchases: PurchaseEconomics[]): DisplayRow[] {
  const rows: DisplayRow[] = []
  // Map from item_id to the bonus-group row already emitted
  const bonusGroups = new Map<string, DisplayRow & { kind: "bonus-group" }>()

  for (const p of purchases) {
    const isAttributedBonus =
      p.purchase_type === "bonus" && !!p.bonus_for_purchase_id

    if (!isAttributedBonus) {
      rows.push({ kind: "purchase", purchase: p })
      continue
    }

    const existing = bonusGroups.get(p.item_id)
    if (existing) {
      // Merge into existing group
      existing.purchaseIds.push(p.purchase_id)
      existing.totalQty += p.quantity
      existing.totalSelling += p.total_selling ? parseFloat(p.total_selling) : 0
      existing.totalCommission += p.total_commission ? parseFloat(p.total_commission) : 0
      if (p.bonus_parent_item_name) {
        existing.attributions.push({
          parentItemName: p.bonus_parent_item_name,
          parentQty: p.bonus_parent_quantity ?? p.quantity,
          invoiceNumber: p.bonus_parent_invoice_number ?? "?",
        })
      }
    } else {
      // Start a new group
      const group: DisplayRow & { kind: "bonus-group" } = {
        kind: "bonus-group",
        representative: p,
        purchaseIds: [p.purchase_id],
        totalQty: p.quantity,
        totalSelling: p.total_selling ? parseFloat(p.total_selling) : 0,
        totalCommission: p.total_commission ? parseFloat(p.total_commission) : 0,
        attributions: p.bonus_parent_item_name
          ? [{
              parentItemName: p.bonus_parent_item_name,
              parentQty: p.bonus_parent_quantity ?? p.quantity,
              invoiceNumber: p.bonus_parent_invoice_number ?? "?",
            }]
          : [],
      }
      bonusGroups.set(p.item_id, group)
      rows.push(group)
    }
  }

  return rows
}
