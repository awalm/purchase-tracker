const API_BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
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
      notes: string | null;
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
      subtotal: string;
      tax_rate: string;
      total: string;
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
      subtotal: string;
      tax_rate: string;
      total: string;
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
      notes: string | null;
    }[]>(`/invoices/${id}/purchases`),
  create: (data: {
    destination_id: string;
    invoice_number: string;
    order_number?: string;
    invoice_date: string;
    subtotal: string;
    tax_rate?: string;
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
  uploadPdf: async (id: string, file: File): Promise<void> => {
    const token = localStorage.getItem('token');
    const formData = new FormData();
    formData.append('file', file);
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
      has_pdf: boolean | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
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
      has_pdf: boolean | null;
      notes: string | null;
      created_at: string;
      updated_at: string;
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
      notes: string | null;
    }[]>(`/receipts/${id}/purchases`),
  create: (data: {
    vendor_id: string;
    receipt_number?: string;
    receipt_date: string;
    subtotal: string;
    tax_amount?: string;
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
  delete: (id: string) =>
    request<void>(`/receipts/${id}`, { method: 'DELETE' }),
  uploadPdf: async (id: string, file: File): Promise<void> => {
    const token = localStorage.getItem('token');
    const formData = new FormData();
    formData.append('file', file);
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
  list: (params?: { status?: string; destination_id?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.destination_id) searchParams.set('destination_id', params.destination_id);
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
      notes: string | null;
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
  invoicePdf: async (file: File): Promise<ParsedInvoice> => {
    const token = localStorage.getItem('token');
    const formData = new FormData();
    formData.append('file', file);
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
