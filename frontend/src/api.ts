import { compressUploadFile } from './lib/uploadCompression';

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
  list: () => request<{ id: string; name: string; short_id: string | null }[]>('/vendors'),
  get: (id: string) => request<{ id: string; name: string; short_id: string | null }>(`/vendors/${id}`),
  create: (data: { name: string; short_id?: string }) =>
    request<{ id: string; name: string; short_id: string | null }>('/vendors', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; short_id?: string }) =>
    request<{ id: string; name: string; short_id: string | null }>(`/vendors/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/vendors/${id}`, { method: 'DELETE' }),
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
    request<{
      purchase_id: string;
      purchase_date: string;
      item_id: string;
      item_name: string;
      vendor_name: string | null;
      destination_code: string | null;
      quantity: number;
      purchase_cost: string;
      total_cost: string | null;
      invoice_unit_price: string | null;
      total_selling: string | null;
      unit_commission: string | null;
      total_commission: string | null;
      tax_paid: string | null;
      tax_owed: string | null;
      status: string;
      delivery_date: string | null;
      invoice_id: string | null;
      receipt_id: string | null;
      receipt_number: string | null;
      invoice_number: string | null;
      allow_receipt_date_override: boolean;
      notes: string | null;
      refunds_purchase_id: string | null;
      purchase_type: string | null;
      bonus_for_purchase_id: string | null;
    }[]>(`/items/${id}/purchases`),
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
    request<{
      purchase_id: string;
      purchase_date: string;
      item_id: string;
      item_name: string;
      vendor_name: string | null;
      destination_code: string | null;
      quantity: number;
      purchase_cost: string;
      total_cost: string | null;
      invoice_unit_price: string | null;
      total_selling: string | null;
      unit_commission: string | null;
      total_commission: string | null;
      tax_paid: string | null;
      tax_owed: string | null;
      status: string;
      delivery_date: string | null;
      invoice_id: string | null;
      receipt_id: string | null;
      receipt_number: string | null;
      invoice_number: string | null;
      allow_receipt_date_override: boolean;
      notes: string | null;
      refunds_purchase_id: string | null;
      purchase_type: string | null;
      bonus_for_purchase_id: string | null;
    }[]>(`/invoices/${id}/purchases`),
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
      tax_rate: string;
      total: string;
      payment_method: string | null;
      ingestion_metadata: ReceiptIngestionMetadata | null;
      has_pdf: boolean | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
      receipt_line_item_count: number;
      purchase_count: number | null;
      purchases_total: string | null;
      total_selling: string | null;
      total_commission: string | null;
      invoiced_count: number | null;
    }[]>('/receipts'),
  get: (id: string) =>
    request<{
      id: string;
      vendor_id: string;
      vendor_name: string;
      receipt_number: string;
      receipt_date: string;
      subtotal: string;
      tax_rate: string;
      total: string;
      payment_method: string | null;
      ingestion_metadata: ReceiptIngestionMetadata | null;
      has_pdf: boolean | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
      receipt_line_item_count: number;
      purchase_count: number | null;
      purchases_total: string | null;
      total_selling: string | null;
      total_commission: string | null;
      invoiced_count: number | null;
    }>(`/receipts/${id}`),
  purchases: (id: string) =>
    request<{
      purchase_id: string;
      purchase_date: string;
      item_id: string;
      item_name: string;
      vendor_name: string | null;
      destination_code: string | null;
      quantity: number;
      purchase_cost: string;
      total_cost: string | null;
      invoice_unit_price: string | null;
      total_selling: string | null;
      unit_commission: string | null;
      total_commission: string | null;
      tax_paid: string | null;
      tax_owed: string | null;
      status: string;
      delivery_date: string | null;
      invoice_id: string | null;
      receipt_id: string | null;
      receipt_number: string | null;
      invoice_number: string | null;
      allow_receipt_date_override: boolean;
      notes: string | null;
      refunds_purchase_id: string | null;
      purchase_type: string | null;
      bonus_for_purchase_id: string | null;
    }[]>(`/receipts/${id}/purchases`),
  lineItems: {
    list: (id: string) =>
      request<ReceiptLineItem[]>(`/receipts/${id}/line-items`),
    create: (id: string, data: { item_id: string; quantity: number; unit_cost: string; notes?: string; parent_line_item_id?: string }) =>
      request<ReceiptLineItem>(`/receipts/${id}/line-items`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, lineItemId: string, data: { item_id?: string; quantity?: number; unit_cost?: string; notes?: string }) =>
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
    return request<{
      purchase_id: string;
      purchase_date: string;
      item_id: string;
      item_name: string;
      vendor_name: string | null;
      destination_code: string | null;
      quantity: number;
      purchase_cost: string;
      total_cost: string | null;
      invoice_unit_price: string | null;
      total_selling: string | null;
      unit_commission: string | null;
      total_commission: string | null;
      tax_paid: string | null;
      tax_owed: string | null;
      status: string;
      delivery_date: string | null;
      invoice_id: string | null;
      receipt_id: string | null;
      receipt_number: string | null;
      invoice_number: string | null;
      allow_receipt_date_override: boolean;
      notes: string | null;
      refunds_purchase_id: string | null;
      purchase_type: string | null;
      bonus_for_purchase_id: string | null;
    }[]>(`/purchases/economics${query ? `?${query}` : ''}`);
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
  allocated_qty: number;
  remaining_qty: number;
  created_at: string;
  updated_at: string;
}
