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

/** A display row — either a regular purchase, a collapsed group of attributed bonuses, or a section header for a named group. */
export type DisplayRow =
  | { kind: "purchase"; purchase: PurchaseEconomics; children?: DisplayRow[] }
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
  | {
      kind: "display-group-header"
      /** The group name */
      groupName: string
      /** Rows within this group */
      rows: DisplayRow[]
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
 * 1. Purchases with the same `display_group` are collected under a
 *    "display-group-header" section row.
 * 2. Within each section (or for ungrouped purchases), attributed bonuses
 *    for the same item_id are collapsed into "bonus-group" rows placed
 *    after the matching unit purchase.
 *
 * Everything else passes through as a "purchase" row.
 */
export function buildDisplayRows(purchases: PurchaseEconomics[]): DisplayRow[] {
  // ── Separate by display_group ──
  const grouped = new Map<string, PurchaseEconomics[]>()
  const ungrouped: PurchaseEconomics[] = []

  for (const p of purchases) {
    if (p.display_group) {
      const existing = grouped.get(p.display_group)
      if (existing) existing.push(p)
      else grouped.set(p.display_group, [p])
    } else {
      ungrouped.push(p)
    }
  }

  // ── Build rows for a set of purchases (shared logic) ──
  const buildSection = (sectionPurchases: PurchaseEconomics[]): DisplayRow[] => {
    const bonusGroups = new Map<string, DisplayRow & { kind: "bonus-group" }>()
    const unplacedBonusGroups = new Set<string>()

    for (const p of sectionPurchases) {
      const isAttributedBonus =
        p.purchase_type === "bonus" && !!p.bonus_for_purchase_id
      if (!isAttributedBonus) continue

      const existing = bonusGroups.get(p.item_id)
      if (existing) {
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
        unplacedBonusGroups.add(p.item_id)
      }
    }

    const rows: DisplayRow[] = []
    for (const p of sectionPurchases) {
      const isAttributedBonus =
        p.purchase_type === "bonus" && !!p.bonus_for_purchase_id
      if (isAttributedBonus) continue

      rows.push({ kind: "purchase", purchase: p })

      // Place bonus group after parent unit row
      const bonusGroup = bonusGroups.get(p.item_id)
      if (bonusGroup && unplacedBonusGroups.has(p.item_id)) {
        rows.push(bonusGroup)
        unplacedBonusGroups.delete(p.item_id)
      }
    }

    // Remaining bonus groups without a matching parent
    for (const itemId of unplacedBonusGroups) {
      const group = bonusGroups.get(itemId)
      if (group) rows.push(group)
    }

    return rows
  }

  // ── Assemble: named groups first, then ungrouped ──
  const result: DisplayRow[] = []

  for (const [groupName, groupPurchases] of grouped) {
    result.push({
      kind: "display-group-header",
      groupName,
      rows: buildSection(groupPurchases),
    })
  }

  result.push(...buildSection(ungrouped))

  return result
}
