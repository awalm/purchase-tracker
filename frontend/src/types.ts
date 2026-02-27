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
  purchase_cost: string;
  start_date: string;
  end_date: string | null;
  default_destination_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Invoice {
  id: string;
  destination_id: string;
  invoice_number: string;
  order_number: string | null;
  invoice_date: string;
  subtotal: string;
  tax_rate: string;
  total: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceWithDestination {
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
}

export type DeliveryStatus = 'pending' | 'in_transit' | 'delivered' | 'returned' | 'damaged' | 'lost';

export interface Purchase {
  id: string;
  item_id: string;
  invoice_id: string | null;
  quantity: number;
  purchase_cost: string;
  selling_price: string | null;
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
  purchase_cost: string;
  default_destination_id: string | null;
  default_destination_code: string | null;
  notes: string | null;
  created_at: string;
}

export interface PurchaseEconomics {
  purchase_id: string;
  purchase_date: string;
  item_name: string;
  vendor_name: string;
  destination_code: string | null;
  quantity: number;
  purchase_cost: string;
  total_cost: string | null;
  selling_price: string | null;
  total_selling: string | null;
  unit_commission: string | null;
  total_commission: string | null;
  tax_paid: string | null;
  tax_owed: string | null;
  status: DeliveryStatus;
  delivery_date: string | null;
  invoice_id: string | null;
}

export interface VendorSummary {
  vendor_id: string;
  vendor_name: string;
  total_purchases: number | null;
  total_quantity: number | null;
  total_spent: string | null;
}

export interface DestinationSummary {
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
