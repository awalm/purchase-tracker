import type { ReceiptLineItem } from "@/api"

export type ReceiptLineItemsCache = Record<string, ReceiptLineItem[]>

export const getReceiptLineItemsFromCache = (
  cache: ReceiptLineItemsCache,
  receiptId: string
): ReceiptLineItem[] | undefined => {
  return cache[receiptId]
}

export const setReceiptLineItemsInCache = (
  cache: ReceiptLineItemsCache,
  receiptId: string,
  rows: ReceiptLineItem[]
): void => {
  cache[receiptId] = rows
}

export const invalidateReceiptLineItemsCache = (
  cache: ReceiptLineItemsCache,
  receiptId?: string
): void => {
  if (receiptId) {
    delete cache[receiptId]
    return
  }

  for (const key of Object.keys(cache)) {
    delete cache[key]
  }
}

export const getOrLoadReceiptLineItems = async (
  cache: ReceiptLineItemsCache,
  receiptId: string,
  loader: (receiptId: string) => Promise<ReceiptLineItem[]>
): Promise<ReceiptLineItem[]> => {
  const cached = getReceiptLineItemsFromCache(cache, receiptId)
  if (cached) {
    return cached
  }

  const rows = await loader(receiptId)
  setReceiptLineItemsInCache(cache, receiptId, rows)
  return rows
}
