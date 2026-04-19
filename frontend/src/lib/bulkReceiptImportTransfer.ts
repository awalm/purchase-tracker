let pendingBulkReceiptFiles: File[] = []

export const setPendingBulkReceiptFiles = (files: File[]) => {
  pendingBulkReceiptFiles = files
}

export const consumePendingBulkReceiptFiles = (): File[] => {
  const files = pendingBulkReceiptFiles
  pendingBulkReceiptFiles = []
  return files
}