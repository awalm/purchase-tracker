import { compressUploadFile } from './lib/uploadCompression';
import type { PurchaseEconomics, ReceiptWithVendor } from './types';

const API_BASE = '/api';

type UploadBehaviorOptions = {
  bypassCompression?: boolean;
  ocrMode?: ReceiptOcrMode;
};

export type ReceiptOcrMode = 'auto' | 'classic' | 'vl';

export interface VendorImportAlias {
  id: string;
  normalized_alias: string;
  raw_alias: string;
  vendor_id: string;
  created_at: string;
  updated_at: string;
}

export interface ReceiptIngestionMetadata {
  source: string;
  auto_parsed?: boolean;
  parse_engine?: string;
  parse_version?: string;
  fixture_used?: string;
  confidence_score?: number;
  raw_vendor_name?: string;
  warnings?: string[];
  ingested_at?: string;
  ingestion_version?: string;
}

export interface ReceiptMetadataAuditEntry {
  id: string;
  receipt_id: string;
  operation: string;
  old_ingestion_metadata: ReceiptIngestionMetadata | null;
  new_ingestion_metadata: ReceiptIngestionMetadata | null;
  user_id: string;
  created_at: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class ApiValidationError<T = unknown> extends ApiError {
  constructor(status: number, message: string, public details: T) {
    super(status, message);
  }
}

async function compressUploadOrThrow(
  file: File,
  options: UploadBehaviorOptions = {},
): Promise<File> {
  if (options.bypassCompression) {
    return file;
  }

  try {
    return await compressUploadFile(file);
  } catch (error) {
    throw new ApiError(
      400,
      error instanceof Error ? error.message : 'Failed to compress the uploaded file.',
    );
  }
}

function formatReceiptParseError(status: number, raw: string): string {
  const message = raw.trim();

  if (status === 0) {
    return 'Network error while parsing receipt. Please verify the app is running and try again.';
  }

  if (status === 413) {
    return 'Uploaded file is too large. Maximum allowed size is 25 MB.';
  }

  if (status === 502) {
    return 'Receipt OCR service is unavailable right now. Please try again in a moment.';
  }

  if (status === 422 && !message) {
    return 'OCR could not extract receipt data from this file. Please try another image or PDF.';
  }

  if (status === 400 && !message) {
    return 'Invalid upload payload. Please upload one PDF or image file.';
  }

  if (message) {
    return message;
  }

  if (status >= 500) {
    return 'Receipt parsing failed due to a server error. Please retry.';
  }

  return `Receipt parsing failed (${status}).`;
}

function buildReceiptImageParseUrl(options: UploadBehaviorOptions): string {
  const params = new URLSearchParams();

  if (options.ocrMode) {
    params.set('ocr_mode', options.ocrMode);
  }

  const query = params.toString();
  return `${API_BASE}/import/receipt-image${query ? `?${query}` : ''}`;
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token');
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    // On 401, clear stale token and redirect to login
    if (response.status === 401 && !endpoint.includes('/auth/')) {
      localStorage.removeItem('token');
      window.location.reload();
    }
    throw new ApiError(response.status, text || response.statusText);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// Auth
export const auth = {
  login: (username: string, password: string) =>
    request<{ token: string; user: { id: string; username: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  register: (username: string, password: string) =>
    request<{ id: string; username: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () =>
    request<{ id: string; username: string }>('/auth/me'),
};

// Vendors
export const vendors = {
  list: () => request<{ id: string; name: string; short_id: string | null; default_location_id: string | null }[]>('/vendors'),
  get: (id: string) => request<{ id: string; name: string; short_id: string | null; default_location_id: string | null }>(`/vendors/${id}`),
  create: (data: { name: string; short_id?: string }) =>
    request<{ id: string; name: string; short_id: string | null; default_location_id: string | null }>('/vendors', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Record<string, unknown>) =>
    request<{ id: string; name: string; short_id: string | null; default_location_id: string | null }>(`/vendors/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/vendors/${id}`, { method: 'DELETE' }),
  applyDefaultLocation: (vendorId: string) =>
    request<{ updated: number }>(`/vendors/${vendorId}/apply-default-location`, {
      method: 'POST',
    }),
  importAliases: {
    list: (vendorId: string) =>
      request<VendorImportAlias[]>(`/vendors/${vendorId}/import-aliases`),
    create: (vendorId: string, rawAlias: string) =>
      request<void>(`/vendors/${vendorId}/import-aliases`, {
        method: 'POST',
        body: JSON.stringify({ raw_alias: rawAlias }),
      }),
    delete: (vendorId: string, aliasId: string) =>
      request<void>(`/vendors/${vendorId}/import-aliases/${aliasId}`, {
        method: 'DELETE',
      }),
  },
};

// Destinations
export const destinations = {
  list: () =>
    request<{ id: string; code: string; name: string; is_active: boolean }[]>('/destinations'),
  create: (data: { code: string; name: string }) =>
    request<{ id: string; code: string; name: string }>('/destinations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { code?: string; name?: string; is_active?: boolean }) =>
    request<{ id: string; code: string; name: string }>(`/destinations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/destinations/${id}`, { method: 'DELETE' }),
};

// Items
export const items = {
  list: () =>
    request<{
      id: string;
      name: string;
      default_destination_id: string | null;
      default_destination_code: string | null;
      notes: string | null;
      created_at: string;
      total_qty: number;
      total_value: string;
      min_unit_cost: string | null;
      avg_unit_cost: string | null;
      max_unit_cost: string | null;
      total_commission: string | null;
      avg_unit_commission: string | null;
      last_receipt_date: string | null;
    }[]>('/items/active'),
  create: (data: {
    name: string;
    default_destination_id?: string;
    notes?: string;
  }) =>
    request<{ id: string }>('/items', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Record<string, unknown>) =>
    request<{ id: string }>(`/items/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/items/${id}`, { method: 'DELETE' }),
  transfer: (sourceId: string, targetItemId: string) =>
    request<{ purchases_transferred: number; receipt_lines_transferred: number }>(
      `/items/${sourceId}/transfer`,
      { method: 'POST', body: JSON.stringify({ target_item_id: targetItemId }) }
    ),
  get: (id: string) =>
    request<{
      id: string;
      name: string;
      default_destination_id: string | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
    }>(`/items/${id}`),
  purchases: (id: string) =>
    request<PurchaseEconomics[]>(`/items/${id}/purchases`),
  receiptLines: (id: string) =>
    request<{
      receipt_line_item_id: string;
      receipt_id: string;
      receipt_number: string;
      receipt_date: string;
      vendor_name: string | null;
      quantity: number;
      unit_cost: string;
      line_total: string;
      receipt_subtotal: string;
      receipt_total: string;
      notes: string | null;
    }[]>(`/items/${id}/receipt-lines`),
};

// Invoices
export const invoices = {
  list: () =>
    request<{
      id: string;
      destination_id: string;
      destination_code: string;
      destination_name: string;
      invoice_number: string;
      order_number: string | null;
      invoice_date: string;
      delivery_date: string | null;
      subtotal: string;
      tax_rate: string;
      total: string;
      reconciliation_state: string;
      has_pdf: boolean | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
      purchase_count: number | null;
      purchases_total: string | null;
      total_cost: string | null;
      total_commission: string | null;
      receipted_count: number | null;
    }[]>('/invoices'),
  get: (id: string) =>
    request<{
      id: string;
      destination_id: string;
      destination_code: string;
      destination_name: string;
      invoice_number: string;
      order_number: string | null;
      invoice_date: string;
      delivery_date: string | null;
      subtotal: string;
      tax_rate: string;
      total: string;
      reconciliation_state: string;
      has_pdf: boolean | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
      purchase_count: number | null;
      purchases_total: string | null;
      total_cost: string | null;
      total_commission: string | null;
      receipted_count: number | null;
    }>(`/invoices/${id}`),
  purchases: (id: string) =>
    request<PurchaseEconomics[]>(`/invoices/${id}/purchases`),
  create: (data: {
    destination_id: string;
    invoice_number: string;
    order_number?: string;
    invoice_date: string;
    delivery_date?: string;
    subtotal: string;
    tax_rate?: string;
    reconciliation_state?: string;
    notes?: string;
  }) =>
    request<{ id: string }>('/invoices', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Record<string, unknown>) =>
    request<{ id: string }>(`/invoices/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/invoices/${id}`, { method: 'DELETE' }),
  uploadPdf: async (
    id: string,
    file: File,
    options: UploadBehaviorOptions = {},
  ): Promise<void> => {
    const token = localStorage.getItem('token');
    const compressedFile = await compressUploadOrThrow(file, options);
    const formData = new FormData();
    formData.append('file', compressedFile);
    const response = await fetch(`${API_BASE}/invoices/${id}/document`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
  },
  downloadBackup: async (id: string): Promise<Blob> => {
    const token = localStorage.getItem('token');
    const response = await fetch(`${API_BASE}/invoices/${id}/backup`, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }

    return response.blob();
  },
  importBackup: async (file: File): Promise<{
    invoice_id: string;
    invoice_number: string;
    restored_purchase_count: number;
    restored_receipt_count: number;
    restored_allocation_count: number;
  }> => {
    const token = localStorage.getItem('token');
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE}/invoices/backup/import`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }

    return response.json();
  },
  downloadAllBackups: async (options?: {
    include_unfinalized?: boolean;
    from?: string;
    to?: string;
    include_documents?: boolean;
  }): Promise<Blob> => {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams();

    if (options?.include_unfinalized !== undefined) {
      params.set('include_unfinalized', String(options.include_unfinalized));
    }
    if (options?.include_documents !== undefined) {
      params.set('include_documents', String(options.include_documents));
    }
    if (options?.from) {
      params.set('from', options.from);
    }
    if (options?.to) {
      params.set('to', options.to);
    }

    const query = params.toString();
    const response = await fetch(`${API_BASE}/invoices/backup/export${query ? `?${query}` : ''}`, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }

    return response.blob();
  },
  importAllBackups: async (file: File): Promise<{
    restored_invoice_count: number;
    restored_purchase_count: number;
    restored_receipt_count: number;
    restored_allocation_count: number;
    restored_invoices: Array<{
      invoice_id: string;
      invoice_number: string;
      restored_purchase_count: number;
      restored_receipt_count: number;
      restored_allocation_count: number;
    }>;
  }> => {
    const token = localStorage.getItem('token');
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE}/invoices/backup/import-all`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }

    return response.json();
  },
  downloadPdfUrl: (id: string) => `${API_BASE}/invoices/${id}/document`,
};

// Receipts
export const receipts = {
  list: () =>
    request<{
      id: string;
      vendor_id: string;
      vendor_name: string;
      receipt_number: string;
      receipt_date: string;
      subtotal: string;
      tax_amount: string;
      total: string;
      payment_method: string | null;
      ingestion_metadata: ReceiptIngestionMetadata | null;
      has_pdf: boolean | null;
      notes: string | null;
      store_location_id: string | null;
      store_label: string | null;
      store_address: string | null;
      store_latitude: number | null;
      store_longitude: number | null;
      created_at: string;
      updated_at: string;
      receipt_line_item_count: number;
      purchase_count: number | null;
      purchases_total: string | null;
      total_selling: string | null;
      total_commission: string | null;
      invoiced_count: number | null;
      locked_purchase_count: number | null;
    }[]>('/receipts'),
  get: (id: string) =>
    request<{
      id: string;
      vendor_id: string;
      vendor_name: string;
      receipt_number: string;
      receipt_date: string;
      subtotal: string;
      tax_amount: string;
      total: string;
      payment_method: string | null;
      ingestion_metadata: ReceiptIngestionMetadata | null;
      has_pdf: boolean | null;
      notes: string | null;
      store_location_id: string | null;
      store_label: string | null;
      store_address: string | null;
      store_latitude: number | null;
      store_longitude: number | null;
      created_at: string;
      updated_at: string;
      receipt_line_item_count: number;
      purchase_count: number | null;
      purchases_total: string | null;
      total_selling: string | null;
      total_commission: string | null;
      invoiced_count: number | null;
      locked_purchase_count: number | null;
    }>(`/receipts/${id}`),
  purchases: (id: string) =>
    request<PurchaseEconomics[]>(`/receipts/${id}/purchases`),
  unlinkPurchase: (receiptId: string, purchaseId: string) =>
    request<void>(`/receipts/${receiptId}/purchases/${purchaseId}`, { method: 'DELETE' }),
  lineItems: {
    list: (id: string) =>
      request<ReceiptLineItem[]>(`/receipts/${id}/line-items`),
    create: (id: string, data: { item_id: string; quantity: number; unit_cost: string; notes?: string; parent_line_item_id?: string; line_type?: string; state?: string }) =>
      request<ReceiptLineItem>(`/receipts/${id}/line-items`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, lineItemId: string, data: { item_id?: string; quantity?: number; unit_cost?: string; notes?: string; state?: string }) =>
      request<ReceiptLineItem>(`/receipts/${id}/line-items/${lineItemId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string, lineItemId: string) =>
      request<void>(`/receipts/${id}/line-items/${lineItemId}`, {
        method: 'DELETE',
      }),
  },
  create: (data: {
    vendor_id: string;
    source_vendor_alias?: string;
    receipt_number?: string;
    receipt_date: string;
    subtotal: string;
    tax_amount?: string;
    payment_method?: string;
    ingestion_metadata?: ReceiptIngestionMetadata;
    notes?: string;
  }) =>
    request<{ id: string }>('/receipts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Record<string, unknown>) =>
    request<{ id: string }>(`/receipts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  metadataAudit: (id: string) =>
    request<ReceiptMetadataAuditEntry[]>(`/receipts/${id}/metadata-audit`),
  delete: (id: string) =>
    request<void>(`/receipts/${id}`, { method: 'DELETE' }),
  uploadPdf: async (
    id: string,
    file: File,
    options: UploadBehaviorOptions = {},
  ): Promise<void> => {
    const token = localStorage.getItem('token');
    const compressedFile = await compressUploadOrThrow(file, options);
    const formData = new FormData();
    formData.append('file', compressedFile);
    const response = await fetch(`${API_BASE}/receipts/${id}/document`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
  },
  downloadPdfUrl: (id: string) => `${API_BASE}/receipts/${id}/document`,
  locations: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return request<ReceiptWithVendor[]>(`/receipts/locations?${params.toString()}`);
  },
};

// Purchases
export const purchases = {
  list: (params?: {
    status?: string;
    destination_id?: string;
    vendor_id?: string;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.destination_id) searchParams.set('destination_id', params.destination_id);
    if (params?.vendor_id) searchParams.set('vendor_id', params.vendor_id);
    if (typeof params?.limit === 'number') searchParams.set('limit', String(params.limit));
    if (typeof params?.offset === 'number') searchParams.set('offset', String(params.offset));
    const query = searchParams.toString();
    return request<PurchaseEconomics[]>(`/purchases/economics${query ? `?${query}` : ''}`);
  },
  create: (data: {
    item_id: string;
    quantity: number;
    purchase_cost: string;
    invoice_unit_price?: string;
    destination_id?: string;
    invoice_id?: string;
    receipt_id?: string;
    status?: string;
    notes?: string;
    refunds_purchase_id?: string;
    purchase_type?: string;
    bonus_for_purchase_id?: string;
  }) =>
    request<{ id: string }>('/purchases', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Record<string, unknown>) =>
    request<{ id: string }>(`/purchases/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/purchases/${id}`, { method: 'DELETE' }),
  split: (id: string, data: { lines: { item_id: string; quantity: number; purchase_type?: string }[] }) =>
    request<{ original_purchase_id: string; created_purchases: string[] }>(`/purchases/${id}/split`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  distributePreview: (id: string) =>
    request<{
      items: { item_id: string; item_name: string; auto_qty: number; parent_count: number }[];
      total_qty: number;
      original_qty: number;
      remainder: number;
    }>(`/purchases/${id}/distribute-preview`),
  distribute: (id: string, data: { items: { item_id: string; quantity?: number }[] }) =>
    request<{
      bonus_purchases_created: number;
      total_qty_attributed: number;
      remainder_qty: number;
      remainder_purchase_id: string | null;
    }>(`/purchases/${id}/distribute`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  allocations: {
    list: (purchaseId: string) =>
      request<PurchaseAllocation[]>(`/purchases/${purchaseId}/allocations`),
    create: (purchaseId: string, data: { receipt_line_item_id: string; allocated_qty: number; allow_receipt_date_override?: boolean }) =>
      request<PurchaseAllocation>(`/purchases/${purchaseId}/allocations`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (
      purchaseId: string,
      allocationId: string,
      data: { receipt_line_item_id?: string; allocated_qty?: number; allow_receipt_date_override?: boolean }
    ) =>
      request<PurchaseAllocation>(`/purchases/${purchaseId}/allocations/${allocationId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (purchaseId: string, allocationId: string) =>
      request<void>(`/purchases/${purchaseId}/allocations/${allocationId}`, {
        method: 'DELETE',
      }),
    auto: (purchaseId: string, data?: { allow_receipt_date_override?: boolean }) =>
      request<AutoAllocatePurchaseResult>(`/purchases/${purchaseId}/allocations/auto`, {
        method: 'POST',
        body: JSON.stringify(data ?? {}),
      }),
  },
};

// Reports
export interface UnreconciledReceiptItem {
  receipt_line_item_id: string;
  receipt_id: string;
  receipt_number: string;
  receipt_date: string;
  vendor_name: string;
  item_id: string;
  item_name: string;
  line_quantity: number;
  unit_cost: string;
  line_total: string;
  allocated_to_invoice_qty: number;
  unreconciled_qty: number;
  unreconciled_value: string;
}

export interface TaxReportAllocation {
  receipt_id: string;
  receipt_number: string;
  receipt_date: string;
  vendor_name: string;
  allocated_qty: number;
  unit_cost: string;
  allocated_total: string;
}

export interface TaxReportPurchase {
  item_name: string;
  quantity: number;
  invoice_unit_price: string;
  purchase_type: string;
  total_cost: string;
  total_revenue: string;
  commission: string;
  bonus_revenue: string;
  hst_on_cost: string;
  hst_on_commission: string;
  allocations: TaxReportAllocation[];
}

export interface TaxReportInvoice {
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  delivery_date: string | null;
  tax_rate: string;
  hst_charged: string;
  total_cost: string;
  total_revenue: string;
  total_commission: string;
  total_hst_on_cost: string;
  total_hst_on_commission: string;
  purchases: TaxReportPurchase[];
}

export interface TaxReportLostItem {
  receipt_id: string;
  receipt_number: string;
  receipt_date: string;
  vendor_name: string;
  item_name: string;
  quantity: number;
  unit_cost: string;
  line_total: string;
  tax_amount: string;
}

export interface TaxReportSummary {
  total_commission: string;
  total_hst_on_cost: string;
  total_hst_on_commission: string;
  total_hst_charged: string;
  total_cost: string;
  total_revenue: string;
  lost_items_cost: string;
  lost_items_tax: string;
  lost_items: TaxReportLostItem[];
  invoices: TaxReportInvoice[];
}

export const reports = {
  vendorSummary: () =>
    request<{
      vendor_id: string;
      vendor_name: string;
      total_receipts: number | null;
      total_purchases: number | null;
      total_quantity: number | null;
      total_spent: string | null;
    }[]>('/reports/vendors'),
  destinationSummary: () =>
    request<{
      destination_id: string;
      destination_code: string;
      destination_name: string;
      total_invoices: number | null;
      total_purchases: number | null;
      total_quantity: number | null;
      total_cost: string | null;
      total_revenue: string | null;
      total_commission: string | null;
      total_tax_paid: string | null;
      total_tax_owed: string | null;
    }[]>('/reports/destinations'),
  unreconciledItems: (from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    return request<UnreconciledReceiptItem[]>(`/reports/unreconciled-items${query ? `?${query}` : ''}`);
  },
  taxReport: (destinationId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    params.set('destination_id', destinationId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    return request<TaxReportSummary>(`/reports/tax?${query}`);
  },
};

// Import
type ImportResult = {
  success_count: number;
  error_count: number;
  duplicate_count: number;
  errors: { row: number; message: string; original_data: string }[];
  failed_rows_csv: string;
};

type PreviewRow<T> = {
  row: number;
  data: T;
  is_duplicate: boolean;
};

type PreviewResult<T> = {
  valid_rows: PreviewRow<T>[];
  error_rows: { row: number; message: string; original_data: string }[];
  total_count: number;
  valid_count: number;
  error_count: number;
  duplicate_count: number;
};

export type VendorPreview = { name: string };
export type DestinationPreview = { code: string; name: string };
export type ItemPreview = {
  name: string;
  destination_code: string | null;
  notes: string | null;
};
export type PurchasePreview = {
  item_name: string;
  vendor_name: string;
  destination_code: string | null;
  quantity: number;
  purchase_cost: string;
  date: string;
  invoice_number: string | null;
  notes: string | null;
};
export type ReceiptImportPreview = {
  vendor_name: string;
  receipt_number: string | null;
  receipt_date: string;
  subtotal: string;
  tax_amount: string | null;
  payment_method: string | null;
  notes: string | null;
};

export type { PreviewResult, PreviewRow };

export const importApi = {
  vendors: (csvData: string) =>
    request<ImportResult>('/import/vendors', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  vendorsPreview: (csvData: string) =>
    request<PreviewResult<VendorPreview>>('/import/vendors/preview', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  destinations: (csvData: string) =>
    request<ImportResult>('/import/destinations', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  destinationsPreview: (csvData: string) =>
    request<PreviewResult<DestinationPreview>>('/import/destinations/preview', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  items: (csvData: string) =>
    request<ImportResult>('/import/items', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  itemsPreview: (csvData: string) =>
    request<PreviewResult<ItemPreview>>('/import/items/preview', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  purchases: (csvData: string) =>
    request<ImportResult>('/import/purchases', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  purchasesPreview: (csvData: string) =>
    request<PreviewResult<PurchasePreview>>('/import/purchases/preview', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  receipts: (csvData: string) =>
    request<ImportResult>('/import/receipts', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  receiptsPreview: (csvData: string) =>
    request<PreviewResult<ReceiptImportPreview>>('/import/receipts/preview', {
      method: 'POST',
      body: JSON.stringify({ csv_data: csvData }),
    }),
  invoicePdf: async (
    file: File,
    options: UploadBehaviorOptions = {},
  ): Promise<ParsedInvoice> => {
    const token = localStorage.getItem('token');
    const compressedFile = await compressUploadOrThrow(file, options);
    const formData = new FormData();
    formData.append('file', compressedFile);
    const response = await fetch(`${API_BASE}/import/invoice-pdf`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
    return response.json();
  },
  receiptImage: async (
    file: File,
    onProgress?: (update: ReceiptImageParseProgress) => void,
    options: UploadBehaviorOptions = {},
  ): Promise<ParsedReceipt> => {
    const token = localStorage.getItem('token');
    const compressedFile = await compressUploadOrThrow(file, options);
    const parseUrl = buildReceiptImageParseUrl(options);

    if (onProgress) {
      return new Promise<ParsedReceipt>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', parseUrl);

        if (token) {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }

        let switchedToProcessing = false;
        onProgress({ stage: 'uploading', progress: 0 });

        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable || event.total <= 0) {
            return;
          }

          const percent = Math.max(
            0,
            Math.min(100, Math.round((event.loaded / event.total) * 100)),
          );
          onProgress({ stage: 'uploading', progress: percent });
        };

        xhr.upload.onload = () => {
          switchedToProcessing = true;
          onProgress({ stage: 'processing', progress: null });
        };

        xhr.onerror = () => {
          reject(new ApiError(0, formatReceiptParseError(0, '')));
        };

        xhr.onload = () => {
          if (!switchedToProcessing) {
            onProgress({ stage: 'processing', progress: null });
          }

          const raw = xhr.responseText || '';
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new ApiError(xhr.status, formatReceiptParseError(xhr.status, raw || xhr.statusText)));
            return;
          }

          try {
            resolve(JSON.parse(raw) as ParsedReceipt);
          } catch {
            reject(new ApiError(xhr.status, 'Invalid JSON response while parsing receipt'));
          }
        };

        const formData = new FormData();
        formData.append('file', compressedFile);
        xhr.send(formData);
      });
    }

    const formData = new FormData();
    formData.append('file', compressedFile);
    const response = await fetch(parseUrl, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(
        response.status,
        formatReceiptParseError(response.status, text || response.statusText),
      );
    }
    return response.json();
  },
  invoicePdfCommit: async (
    file: File,
    payload: InvoicePdfCommitPayload,
    options: UploadBehaviorOptions = {},
  ): Promise<InvoicePdfCommitResponse> => {
    const token = localStorage.getItem('token');
    const compressedFile = await compressUploadOrThrow(file, options);
    const formData = new FormData();
    formData.append('file', compressedFile);
    formData.append('payload', JSON.stringify(payload));

    const response = await fetch(`${API_BASE}/import/invoice-pdf/commit`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });

    if (!response.ok) {
      const raw = await response.text();
      let details: InvoicePdfCommitErrorResponse | null = null;
      try {
        details = JSON.parse(raw) as InvoicePdfCommitErrorResponse;
      } catch {
        details = null;
      }

      if (details && typeof details.message === 'string') {
        throw new ApiValidationError(response.status, details.message || response.statusText, details);
      }

      throw new ApiError(response.status, raw || response.statusText);
    }

    return response.json();
  },
};

// Parsed invoice types
export interface ParsedInvoiceLineItem {
  description: string;
  qty: number;
  invoice_unit_price: string;
  subtotal: string;
}

export interface ParsedInvoice {
  invoice_number: string | null;
  invoice_date: string | null;
  bill_to: string | null;
  line_items: ParsedInvoiceLineItem[];
  subtotal: string | null;
  tax_rate: string | null;
  tax_amount: string | null;
  total: string | null;
  notes: string | null;
}

export interface ParsedReceiptLineItem {
  description: string;
  quantity: number;
  unit_cost: string | null;
  line_total: string | null;
  confidence: number | null;
  sub_items?: ParsedReceiptLineItem[];
}

export interface ParsedReceipt {
  vendor_name: string | null;
  suggested_vendor_id: string | null;
  fixture_used?: string | null;
  receipt_number: string | null;
  receipt_date: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  payment_method: string | null;
  confidence_score?: number | null;
  parse_engine?: string | null;
  parse_version?: string | null;
  line_items: ParsedReceiptLineItem[];
  warnings: string[];
  raw_text_lines?: string[];
}

export interface ReceiptImageParseProgress {
  stage: 'uploading' | 'processing';
  progress: number | null;
}

export interface InvoicePdfCommitLineItemSplit {
  item_id: string;
  qty: number;
  purchase_type?: string;
}

export interface InvoicePdfCommitLineInput {
  line_index: number;
  description: string;
  qty: number;
  invoice_unit_price: string;
  subtotal: string;
  item_id: string | null;
  splits?: InvoicePdfCommitLineItemSplit[];
  purchase_type?: string;
}

export interface InvoicePdfCommitPayload {
  destination_id: string;
  invoice_number: string;
  invoice_date: string;
  delivery_date?: string;
  subtotal: string;
  tax_rate?: string;
  notes?: string;
  line_items: InvoicePdfCommitLineInput[];
}

export interface InvoicePdfFieldError {
  field: string;
  code: string;
  message: string;
}

export interface InvoicePdfLineFailure {
  line_index: number;
  code: string;
  message: string;
  description: string | null;
}

export interface InvoicePdfCommitErrorResponse {
  error_code: string;
  message: string;
  invoice_level_errors: InvoicePdfFieldError[];
  line_failures: InvoicePdfLineFailure[];
}

export interface InvoicePdfCommitResponse {
  invoice_id: string;
  purchase_count: number;
  message: string;
}

export interface PurchaseAllocation {
  id: string;
  purchase_id: string;
  receipt_id: string;
  receipt_line_item_id: string | null;
  item_id: string | null;
  item_name: string | null;
  allocated_qty: number;
  unit_cost: string;
  receipt_number: string;
  vendor_name: string;
  receipt_date: string;
  refunded_on_invoice: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutoAllocatePurchaseResult {
  purchase_id: string;
  purchase_qty: number;
  previously_allocated_qty: number;
  auto_allocated_qty: number;
  total_allocated_qty: number;
  remaining_qty: number;
  allocations_created: number;
  allocations_updated: number;
  receipts_touched: number;
  warning: string | null;
}

export interface ReceiptLineItem {
  id: string;
  receipt_id: string;
  item_id: string;
  item_name: string;
  quantity: number;
  unit_cost: string;
  notes: string | null;
  parent_line_item_id: string | null;
  state: string;
  line_type: string;
  allocated_qty: number;
  remaining_qty: number;
  created_at: string;
  updated_at: string;
}

// ============================================
// Travel Report
// ============================================

export interface TravelLocation {
  id: string;
  config_key: string;
  label: string;
  chain: string | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
  geocode_status: string;
  geocode_error: string | null;
  location_type: string;
  excluded: boolean;
  created_at: string;
  updated_at: string;
}

export interface TravelUpload {
  id: string;
  filename: string;
  uploaded_at: string;
  date_range_start: string | null;
  date_range_end: string | null;
  total_segments: number;
  total_visits: number;
  total_activities: number;
  processing_status: string;
  processing_error: string | null;
  created_at: string;
}

export interface TravelSegment {
  id: string;
  upload_id: string;
  trip_date: string;
  segment_order: number;
  segment_type: string;
  activity_id: string | null;
  distance_meters: number | null;
  visit_id: string | null;
  start_time: string | null;
  end_time: string | null;
  from_location: string | null;
  to_location: string | null;
  classification: string;
  classification_reason: string | null;
  is_detour: boolean;
  detour_extra_km: number | null;
  linked_receipt_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  visit_location_label: string | null;
  visit_location_chain: string | null;
  visit_duration_minutes: number | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  route_coords: [number, number][] | null;
  detour_stop_ids: string[] | null;
  direct_km: number | null;
  with_stops_km: number | null;
}

export interface TravelTripSummary {
  trip_date: string;
  total_distance_km: number;
  business_km: number;
  personal_km: number;
  commute_km: number;
  unclassified_km: number;
  segment_count: number;
  store_visits: string[];
}

export interface TravelSummary {
  total_km: number;
  business_km: number;
  personal_km: number;
  commute_km: number;
  unclassified_km: number;
  business_percentage: number;
  total_trips: number;
  total_store_visits: number;
  trips: TravelTripSummary[];
}

export interface GeocodeDetail {
  address: string;
  status: string;
  error: string | null;
  lat: number | null;
  lng: number | null;
}

export interface TravelTripLog {
  id: string;
  upload_id: string | null;
  trip_date: string;
  purpose: string;
  notes: string;
  total_km: number;
  business_km: number;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface TravelYearlyMileage {
  year: number;
  total_km: number;
  created_at: string;
  updated_at: string;
}

export interface TripLogWithSegments extends TravelTripLog {
  segments: TravelSegment[];
}

export interface CreateManualSegment {
  from_location: string;
  to_location: string;
  distance_km: number;
  classification: string;
  route_coords?: [number, number][];
  is_detour?: boolean;
  detour_stop_ids?: string[];
  direct_km?: number;
  with_stops_km?: number;
}

export interface GeocodeResponse {
  provider: string;
  total: number;
  success: number;
  failed: number;
  details: GeocodeDetail[];
}

export const travel = {
  // Locations
  locations: {
    list: () => request<TravelLocation[]>('/travel/locations'),
    get: (id: string) => request<TravelLocation>(`/travel/locations/${id}`),
    create: (data: { label: string; chain?: string; address: string; location_type: string; excluded?: boolean; skip_geocode?: boolean }) =>
      request<TravelLocation>('/travel/locations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { label?: string; chain?: string; address?: string; location_type?: string; excluded?: boolean; skip_geocode?: boolean }) =>
      request<TravelLocation>(`/travel/locations/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<void>(`/travel/locations/${id}`, { method: 'DELETE' }),
    import: (locations: { label: string; chain?: string; address: string; location_type: string; excluded?: boolean }[]) =>
      request<{ imported: number; skipped: number }>('/travel/locations/import', {
        method: 'POST',
        body: JSON.stringify({ locations }),
      }),
    geocode: (locationIds?: string[]) =>
      request<GeocodeResponse>('/travel/locations/geocode', {
        method: 'POST',
        body: JSON.stringify(locationIds ? { location_ids: locationIds } : {}),
      }),
  },

  // Uploads
  uploads: {
    list: () => request<TravelUpload[]>('/travel/uploads'),
    upload: async (file: File): Promise<TravelUpload> => {
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_BASE}/travel/uploads`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: formData,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new ApiError(response.status, text || response.statusText);
      }
      return response.json();
    },
    delete: (id: string) =>
      request<void>(`/travel/uploads/${id}`, { method: 'DELETE' }),
    reparse: (id: string) =>
      request<TravelUpload>(`/travel/uploads/${id}/reparse`, { method: 'POST' }),
  },

  // Segments
  segments: {
    list: (uploadId: string, from?: string, to?: string) => {
      const params = new URLSearchParams();
      params.set('upload_id', uploadId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return request<TravelSegment[]>(`/travel/segments?${params.toString()}`);
    },
    listByDate: (date: string) => {
      const params = new URLSearchParams();
      params.set('from', date);
      return request<TravelSegment[]>(`/travel/segments?${params.toString()}`);
    },
    classify: (id: string, data: { classification?: string; notes?: string }) =>
      request<TravelSegment>(`/travel/segments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    linkReceipt: (id: string, receiptId: string | null) =>
      request<TravelSegment>(`/travel/segments/${id}/link-receipt`, {
        method: 'POST',
        body: JSON.stringify({ receipt_id: receiptId }),
      }),
    dates: () => request<{ date: string; business_visits: string[] }[]>('/travel/segments/dates'),
  },

  // Summary
  summary: (uploadId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    params.set('upload_id', uploadId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return request<TravelSummary>(`/travel/summary?${params.toString()}`);
  },

  // Trip Logs
  tripLogs: {
    list: (uploadId?: string) => {
      const params = new URLSearchParams();
      if (uploadId) params.set('upload_id', uploadId);
      const qs = params.toString();
      return request<TravelTripLog[]>(`/travel/trip-logs${qs ? `?${qs}` : ''}`);
    },
    create: (data: { upload_id?: string; trip_date: string; purpose?: string; notes?: string; source?: string }) =>
      request<TripLogWithSegments>(`/travel/trip-logs`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    createFromReceipt: (data: { trip_date: string; purpose?: string; notes?: string; segments: CreateManualSegment[] }) =>
      request<TripLogWithSegments>(`/travel/trip-logs/receipt`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    get: (id: string) =>
      request<TripLogWithSegments>(`/travel/trip-logs/${id}`),
    update: (id: string, data: { purpose?: string; notes?: string; status?: string; segments?: CreateManualSegment[] }) =>
      request<TravelTripLog>(`/travel/trip-logs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<void>(`/travel/trip-logs/${id}`, { method: 'DELETE' }),
  },

  // Yearly Mileage
  yearlyMileage: {
    list: () => request<TravelYearlyMileage[]>('/travel/yearly-mileage'),
    upsert: (year: number, total_km: number) =>
      request<TravelYearlyMileage>(`/travel/yearly-mileage/${year}`, {
        method: 'PUT',
        body: JSON.stringify({ total_km }),
      }),
  },

  rematchVisits: (date: string, radiusMeters: number) =>
    request<{ total_visits: number; matched: number; updated: number; radius_meters: number }>(`/travel/segments/rematch`, {
      method: 'POST',
      body: JSON.stringify({ date, radius_meters: radiusMeters }),
    }),

  directions: (fromLat: number, fromLng: number, toLat: number, toLng: number, waypoints?: [number, number][]) => {
    let url = `/travel/directions?from_lat=${fromLat}&from_lng=${fromLng}&to_lat=${toLat}&to_lng=${toLng}`
    if (waypoints && waypoints.length > 0) {
      const wp = waypoints.map(([lat, lng]) => `${lat},${lng}`).join('|')
      url += `&waypoints=${encodeURIComponent(wp)}`
    }
    return request<{ distance_meters: number; coords: [number, number][] }>(url)
  },
};
