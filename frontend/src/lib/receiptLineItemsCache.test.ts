import { describe, expect, it, vi } from "vitest"
import {
  getOrLoadReceiptLineItems,
  invalidateReceiptLineItemsCache,
  type ReceiptLineItemsCache,
} from "./receiptLineItemsCache"
import type { ReceiptLineItem } from "@/api"

const makeLine = (remainingQty: number): ReceiptLineItem => ({
  id: "line-1",
  receipt_id: "receipt-1",
  item_id: "item-1",
  item_name: "Roku Streaming Stick",
  quantity: 12,
  unit_cost: "39.99",
  notes: null,
  allocated_qty: 12 - remainingQty,
  remaining_qty: remainingQty,
  created_at: "2026-04-18T00:00:00Z",
  updated_at: "2026-04-18T00:00:00Z",
})

describe("receiptLineItemsCache", () => {
  it("returns cached rows without reloading", async () => {
    const cache: ReceiptLineItemsCache = {}
    const firstRows = [makeLine(12)]
    const loader = vi.fn().mockResolvedValue(firstRows)

    const initial = await getOrLoadReceiptLineItems(cache, "receipt-1", loader)
    const repeated = await getOrLoadReceiptLineItems(cache, "receipt-1", loader)

    expect(initial).toEqual(firstRows)
    expect(repeated).toEqual(firstRows)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it("reloads fresh rows after cache invalidation (regression for add-then-remove allocation)", async () => {
    const cache: ReceiptLineItemsCache = {}
    const staleRows = [makeLine(0)]
    const freshRows = [makeLine(12)]
    const loader = vi
      .fn<(_: string) => Promise<ReceiptLineItem[]>>()
      .mockResolvedValueOnce(staleRows)
      .mockResolvedValueOnce(freshRows)

    const staleInitial = await getOrLoadReceiptLineItems(cache, "receipt-1", loader)
    expect(staleInitial[0].remaining_qty).toBe(0)

    const staleCached = await getOrLoadReceiptLineItems(cache, "receipt-1", loader)
    expect(staleCached[0].remaining_qty).toBe(0)
    expect(loader).toHaveBeenCalledTimes(1)

    invalidateReceiptLineItemsCache(cache, "receipt-1")

    const refreshed = await getOrLoadReceiptLineItems(cache, "receipt-1", loader)
    expect(refreshed[0].remaining_qty).toBe(12)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("clears the entire cache when no receipt id is provided", async () => {
    const cache: ReceiptLineItemsCache = {}
    const loader = vi
      .fn<(_: string) => Promise<ReceiptLineItem[]>>()
      .mockResolvedValue([makeLine(3)])

    await getOrLoadReceiptLineItems(cache, "receipt-1", loader)
    await getOrLoadReceiptLineItems(cache, "receipt-2", loader)
    expect(loader).toHaveBeenCalledTimes(2)

    invalidateReceiptLineItemsCache(cache)

    await getOrLoadReceiptLineItems(cache, "receipt-1", loader)
    expect(loader).toHaveBeenCalledTimes(3)
  })
})
