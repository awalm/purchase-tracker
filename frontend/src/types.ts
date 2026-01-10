// API Types matching backend models

export interface Vendor {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Destination {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: string;
  name: string;
  vendor_id: string;
  unit_cost: string;
  start_date: string;
  end_date: string | null;
  default_destination_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Payout {
  id: string;
  destination_id: string;
  item_id: string;
  payout_price: string;
  start_date: string;
  end_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncomingInvoice {
  id: string;
  vendor_id: string;
  invoice_number: string;
  order_number: string | null;
  invoice_date: string;
  total: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type DeliveryStatus = 'pending' | 'in_transit' | 'delivered' | 'damaged' | 'returned' | 'lost';

export interface Purchase {
  id: string;
  item_id: string;
  invoice_id: string | null;
  quantity: number;
  unit_cost: string;
  destination_id: string | null;
  status: DeliveryStatus;
  delivery_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// View types
export interface ActiveItem {
  id: string;
  name: string;
  vendor_id: string;
  vendor_name: string;
  unit_cost: string;
  default_destination_id: string | null;
  default_destination_code: string | null;
  notes: string | null;
}

export interface ActivePayout {
  id: string;
  item_id: string;
  item_name: string;
  destination_id: string;
  destination_code: string;
  payout_price: string;
  notes: string | null;
}

export interface PurchaseEconomics {
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
  status: DeliveryStatus;
  delivery_date: string | null;
  invoice_id: string | null;
}

export interface VendorSummary {
  vendor_id: string;
  vendor_name: string;
  total_invoices: number | null;
  total_purchases: number | null;
  total_quantity: number | null;
  total_spent: string | null;
}

export interface DestinationSummary {
  destination_id: string;
  destination_code: string;
  destination_name: string;
  total_purchases: number | null;
  total_quantity: number | null;
  total_cost: string | null;
  total_profit: string | null;
}

// Auth types
export interface User {
  id: string;
  username: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}
