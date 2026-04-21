import type { ReceiptOcrMode } from "@/api"

type PendingBulkReceiptImport = {
  files: File[]
  ocrMode: ReceiptOcrMode | null
}

let pendingBulkReceiptImport: PendingBulkReceiptImport = {
  files: [],
  ocrMode: null,
}

export const setPendingBulkReceiptFiles = (
  files: File[],
  ocrMode: ReceiptOcrMode | null = null
) => {
  pendingBulkReceiptImport = {
    files,
    ocrMode,
  }
}

export const consumePendingBulkReceiptFiles = (): PendingBulkReceiptImport => {
  const pending = pendingBulkReceiptImport
  pendingBulkReceiptImport = {
    files: [],
    ocrMode: null,
  }
  return pending
}