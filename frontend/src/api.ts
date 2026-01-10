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
  list: () => request<{ id: string; name: string }[]>('/vendors'),
  get: (id: string) => request<{ id: string; name: string }>(`/vendors/${id}`),
  create: (name: string) =>
    request<{ id: string; name: string }>('/vendors', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  update: (id: string, name: string) =>
    request<{ id: string; name: string }>(`/vendors/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
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
      vendor_id: string;
      vendor_name: string;
      unit_cost: string;
      default_destination_id: string | null;
      default_destination_code: string | null;
      notes: string | null;
    }[]>('/items'),
  create: (data: {
    name: string;
    vendor_id: string;
    unit_cost: string;
    start_date: string;
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
};

// Payouts
export const payouts = {
  list: () =>
    request<{
      id: string;
      item_id: string;
      item_name: string;
      destination_id: string;
      destination_code: string;
      payout_price: string;
      notes: string | null;
    }[]>('/payouts'),
  create: (data: {
    destination_id: string;
    item_id: string;
    payout_price: string;
    start_date: string;
    notes?: string;
  }) =>
    request<{ id: string }>('/payouts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/payouts/${id}`, { method: 'DELETE' }),
};

// Invoices
export const invoices = {
  list: () =>
    request<{
      id: string;
      vendor_id: string;
      invoice_number: string;
      order_number: string | null;
      invoice_date: string;
      total: string;
      notes: string | null;
    }[]>('/invoices'),
  create: (data: {
    vendor_id: string;
    invoice_number: string;
    order_number?: string;
    invoice_date: string;
    total: string;
    notes?: string;
  }) =>
    request<{ id: string }>('/invoices', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/invoices/${id}`, { method: 'DELETE' }),
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
      item_name: string;
      vendor_name: string;
      destination_code: string | null;
      quantity: number;
      unit_cost: string;
      payout_price: string | null;
      unit_profit: string | null;
      total_profit: string | null;
      total_cost: string | null;
      total_revenue: string | null;
      status: string;
      delivery_date: string | null;
      invoice_id: string | null;
    }[]>(`/purchases${query ? `?${query}` : ''}`);
  },
  create: (data: {
    item_id: string;
    quantity: number;
    unit_cost: string;
    destination_id?: string;
    invoice_id?: string;
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
      total_invoices: number | null;
      total_purchases: number | null;
      total_quantity: number | null;
      total_spent: string | null;
    }[]>('/reports/vendors'),
  destinationSummary: () =>
    request<{
      destination_id: string;
      destination_code: string;
      destination_name: string;
      total_purchases: number | null;
      total_quantity: number | null;
      total_cost: string | null;
      total_profit: string | null;
    }[]>('/reports/destinations'),
};
