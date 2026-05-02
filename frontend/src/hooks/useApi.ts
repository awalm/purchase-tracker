import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { vendors, destinations, items, invoices, receipts, purchases, reports, travel } from "@/api"
import type { ReceiptIngestionMetadata, CreateManualSegment } from "@/api"

// ============================================
// Vendors
// ============================================
export function useVendors() {
  return useQuery({
    queryKey: ["vendors"],
    queryFn: vendors.list,
  })
}

export function useVendor(id: string) {
  return useQuery({
    queryKey: ["vendors", id],
    queryFn: () => vendors.get(id),
    enabled: !!id,
  })
}

export function useCreateVendor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; short_id?: string }) => vendors.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vendors"] }),
  })
}

export function useUpdateVendor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [key: string]: unknown }) => vendors.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vendors"] }),
  })
}

export function useApplyVendorDefaultLocation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (vendorId: string) => vendors.applyDefaultLocation(vendorId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["receipts"] }),
  })
}

export function useDeleteVendor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => vendors.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vendors"] }),
  })
}

export function useVendorImportAliases(vendorId: string) {
  return useQuery({
    queryKey: ["vendors", vendorId, "import-aliases"],
    queryFn: () => vendors.importAliases.list(vendorId),
    enabled: !!vendorId,
  })
}

export function useCreateVendorImportAlias(vendorId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (rawAlias: string) => vendors.importAliases.create(vendorId, rawAlias),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vendors", vendorId, "import-aliases"] }),
  })
}

export function useDeleteVendorImportAlias(vendorId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (aliasId: string) => vendors.importAliases.delete(vendorId, aliasId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vendors", vendorId, "import-aliases"] }),
  })
}

// ============================================
// Destinations
// ============================================
export function useDestinations() {
  return useQuery({
    queryKey: ["destinations"],
    queryFn: destinations.list,
  })
}

export function useCreateDestination() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { code: string; name: string }) => destinations.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["destinations"] }),
  })
}

export function useUpdateDestination() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; code?: string; name?: string; is_active?: boolean }) =>
      destinations.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["destinations"] }),
  })
}

export function useDeleteDestination() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => destinations.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["destinations"] }),
  })
}

// ============================================
// Items
// ============================================
export function useItems() {
  return useQuery({
    queryKey: ["items"],
    queryFn: items.list,
  })
}

export function useCreateItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      name: string
      default_destination_id?: string
      notes?: string
    }) => items.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["items"] }),
  })
}

export function useUpdateItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) => items.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["items"] }),
  })
}

export function useDeleteItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => items.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["items"] }),
  })
}

export function useTransferItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ sourceId, targetItemId }: { sourceId: string; targetItemId: string }) =>
      items.transfer(sourceId, targetItemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["items"] })
      queryClient.invalidateQueries({ queryKey: ["item"] })
    },
  })
}

export function useItem(id: string) {
  return useQuery({
    queryKey: ["item", id],
    queryFn: () => items.get(id),
    enabled: !!id,
  })
}

export function useItemPurchases(id: string) {
  return useQuery({
    queryKey: ["item", id, "purchases"],
    queryFn: () => items.purchases(id),
    enabled: !!id,
  })
}

export function useItemReceiptLines(id: string) {
  return useQuery({
    queryKey: ["item", id, "receipt-lines"],
    queryFn: () => items.receiptLines(id),
    enabled: !!id,
  })
}

// ============================================
// Invoices
// ============================================
export function useInvoices() {
  return useQuery({
    queryKey: ["invoices"],
    queryFn: invoices.list,
  })
}

export function useInvoice(id: string) {
  return useQuery({
    queryKey: ["invoices", id],
    queryFn: () => invoices.get(id),
    enabled: !!id,
  })
}

export function useInvoicePurchases(id: string) {
  return useQuery({
    queryKey: ["invoices", id, "purchases"],
    queryFn: () => invoices.purchases(id),
    enabled: !!id,
  })
}

export function useCreateInvoice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      destination_id: string
      invoice_number: string
      order_number?: string
      invoice_date: string
      delivery_date?: string
      subtotal: string
      tax_rate?: string
      notes?: string
    }) => invoices.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invoices"] }),
  })
}

export function useUpdateInvoice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      invoices.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invoices"] }),
  })
}

export function useDeleteInvoice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => invoices.delete(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
        queryClient.invalidateQueries({ queryKey: ["receipts"] }),
        queryClient.invalidateQueries({ queryKey: ["purchases"] }),
        queryClient.invalidateQueries({ queryKey: ["item"] }),
        queryClient.invalidateQueries({ queryKey: ["items"] }),
      ])
    },
  })
}

// ============================================
// Receipts
// ============================================
export function useReceipts() {
  return useQuery({
    queryKey: ["receipts"],
    queryFn: receipts.list,
  })
}

export function useReceipt(id: string) {
  return useQuery({
    queryKey: ["receipts", id],
    queryFn: () => receipts.get(id),
    enabled: !!id,
  })
}

export function useReceiptPurchases(id: string) {
  return useQuery({
    queryKey: ["receipts", id, "purchases"],
    queryFn: () => receipts.purchases(id),
    enabled: !!id,
  })
}

export function useCreateReceipt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      vendor_id: string
      source_vendor_alias?: string
      receipt_number?: string
      receipt_date: string
      subtotal: string
      tax_amount?: string
      payment_method?: string
      ingestion_metadata?: ReceiptIngestionMetadata
      notes?: string
    }) => receipts.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["receipts"] }),
  })
}

export function useUpdateReceipt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      receipts.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["receipts"] }),
  })
}

export function useDeleteReceipt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => receipts.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["receipts"] }),
  })
}

// ============================================
// Purchases
// ============================================
export function usePurchases(params?: {
  status?: string
  destination_id?: string
  vendor_id?: string
  limit?: number
  offset?: number
}) {
  return useQuery({
    queryKey: ["purchases", params],
    queryFn: () => purchases.list(params),
  })
}

export function useCreatePurchase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: {
      item_id: string
      quantity: number
      purchase_cost: string
      invoice_unit_price?: string
      destination_id?: string
      invoice_id?: string
      receipt_id?: string
      status?: string
      notes?: string
      refunds_purchase_id?: string
      purchase_type?: string
      bonus_for_purchase_id?: string
    }) => purchases.create(data),
    onSuccess: () => {
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["purchases"] }),
        queryClient.invalidateQueries({ queryKey: ["reports"] }),
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
        queryClient.invalidateQueries({ queryKey: ["receipts"] }),
        queryClient.invalidateQueries({ queryKey: ["item"] }),
      ])
    },
  })
}

export function useUpdatePurchase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) => purchases.update(id, data),
    onSuccess: () => {
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["purchases"] }),
        queryClient.invalidateQueries({ queryKey: ["reports"] }),
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
        queryClient.invalidateQueries({ queryKey: ["receipts"] }),
        queryClient.invalidateQueries({ queryKey: ["item"] }),
      ])
    },
  })
}

export function useDeletePurchase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => purchases.delete(id),
    onSuccess: () => {
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ["purchases"] }),
        queryClient.invalidateQueries({ queryKey: ["reports"] }),
        queryClient.invalidateQueries({ queryKey: ["invoices"] }),
        queryClient.invalidateQueries({ queryKey: ["receipts"] }),
        queryClient.invalidateQueries({ queryKey: ["item"] }),
      ])
    },
  })
}

// ============================================
// Reports
// ============================================
export function useVendorSummary() {
  return useQuery({
    queryKey: ["reports", "vendors"],
    queryFn: reports.vendorSummary,
  })
}

export function useDestinationSummary() {
  return useQuery({
    queryKey: ["reports", "destinations"],
    queryFn: reports.destinationSummary,
  })
}

export function useUnreconciledItems(from?: string, to?: string) {
  return useQuery({
    queryKey: ["reports", "unreconciled-items", from, to],
    queryFn: () => reports.unreconciledItems(from, to),
  })
}

export function useTaxReport(destinationId: string | undefined, from?: string, to?: string) {
  return useQuery({
    queryKey: ["reports", "tax", destinationId, from, to],
    queryFn: () => reports.taxReport(destinationId!, from, to),
    enabled: !!destinationId,
  })
}

// ============================================
// Travel
// ============================================
export function useTravelLocations() {
  return useQuery({
    queryKey: ["travel", "locations"],
    queryFn: travel.locations.list,
  })
}

export function useCreateTravelLocation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { label: string; chain?: string; address: string; location_type: string; excluded?: boolean }) =>
      travel.locations.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["travel", "locations"] }),
  })
}

export function useUpdateTravelLocation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; label?: string; chain?: string; address?: string; location_type?: string; excluded?: boolean }) =>
      travel.locations.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["travel", "locations"] }),
  })
}

export function useDeleteTravelLocation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => travel.locations.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["travel", "locations"] }),
  })
}

export function useImportTravelLocations() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (locations: { label: string; chain?: string; address: string; location_type: string; excluded?: boolean }[]) =>
      travel.locations.import(locations),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["travel", "locations"] }),
  })
}

export function useGeocodeTravelLocations() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (locationIds?: string[]) => travel.locations.geocode(locationIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["travel", "locations"] }),
  })
}

export function useTravelUploads() {
  return useQuery({
    queryKey: ["travel", "uploads"],
    queryFn: travel.uploads.list,
  })
}

export function useUploadTimeline() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => travel.uploads.upload(file),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["travel", "uploads"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "segments"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "summary"] })
    },
  })
}

export function useDeleteTravelUpload() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => travel.uploads.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["travel", "uploads"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "segments"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "summary"] })
    },
  })
}

export function useReparseTravelUpload() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => travel.uploads.reparse(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["travel", "uploads"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "segments"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "summary"] })
    },
  })
}

export function useTravelSegments(uploadId: string | undefined, from?: string, to?: string) {
  return useQuery({
    queryKey: ["travel", "segments", uploadId, from, to],
    queryFn: () => travel.segments.list(uploadId!, from, to),
    enabled: !!uploadId,
  })
}

export function useTravelSegmentsForDate(date: string | null) {
  return useQuery({
    queryKey: ["travel", "segments-by-date", date],
    queryFn: () => travel.segments.listByDate(date!),
    enabled: !!date,
  })
}

export function useClassifySegment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; classification?: string; notes?: string }) =>
      travel.segments.classify(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["travel", "segments"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "summary"] })
    },
  })
}

export function useLinkReceiptToSegment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, receiptId }: { id: string; receiptId: string | null }) =>
      travel.segments.linkReceipt(id, receiptId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["travel", "segments"] }),
  })
}

export function useReceiptLocations(from?: string, to?: string) {
  return useQuery({
    queryKey: ["receipts", "locations", from, to],
    queryFn: () => receipts.locations(from, to),
  })
}

export function useTravelSummary(uploadId: string | undefined, from?: string, to?: string) {
  return useQuery({
    queryKey: ["travel", "summary", uploadId, from, to],
    queryFn: () => travel.summary(uploadId!, from, to),
    enabled: !!uploadId,
  })
}

export function useTripLogs(uploadId?: string) {
  return useQuery({
    queryKey: ["travel", "trip-logs", uploadId || "all"],
    queryFn: () => travel.tripLogs.list(uploadId),
  })
}

export function useCreateTripLog() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { upload_id?: string; trip_date: string; purpose?: string; notes?: string; source?: string }) =>
      travel.tripLogs.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["travel", "trip-logs"] })
    },
  })
}

export function useCreateReceiptTripLog() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { trip_date: string; purpose?: string; notes?: string; segments: CreateManualSegment[] }) =>
      travel.tripLogs.createFromReceipt(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["travel", "trip-logs"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "segments-by-date"] })
    },
  })
}

export function useUpdateTripLog() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; purpose?: string; notes?: string; status?: string; segments?: CreateManualSegment[] }) =>
      travel.tripLogs.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["travel", "trip-logs"] })
      queryClient.invalidateQueries({ queryKey: ["travel", "segments-by-date"] })
    },
  })
}

export function useDeleteTripLog() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => travel.tripLogs.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["travel", "trip-logs"] })
    },
  })
}
