import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { vendors, destinations, items, invoices, receipts, purchases, reports } from "@/api"

// ============================================
// Vendors
// ============================================
export function useVendors() {
  return useQuery({
    queryKey: ["vendors"],
    queryFn: vendors.list,
  })
}

export function useCreateVendor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => vendors.create(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vendors"] }),
  })
}

export function useUpdateVendor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => vendors.update(id, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vendors"] }),
  })
}

export function useDeleteVendor() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => vendors.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vendors"] }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invoices"] }),
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
      receipt_number: string
      receipt_date: string
      subtotal: string
      tax_rate?: string
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
export function usePurchases(params?: { status?: string; destination_id?: string }) {
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
      selling_price?: string
      destination_id?: string
      invoice_id?: string
      receipt_id?: string
      status?: string
      notes?: string
    }) => purchases.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchases"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })
    },
  })
}

export function useUpdatePurchase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) => purchases.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchases"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })
    },
  })
}

export function useDeletePurchase() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => purchases.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchases"] })
      queryClient.invalidateQueries({ queryKey: ["reports"] })
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
