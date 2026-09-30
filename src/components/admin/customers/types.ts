/**
 * Row shapes for the admin Customers tab (02_customers_and_auth.sql, 07_orders.sql). Admin reads
 * use select("*") (ADMIN_KIT §3), so every field is read defensively.
 */

export const CUSTOMERS_MIGRATION = "02_customers_and_auth.sql";
export const ORDERS_MIGRATION = "07_orders.sql";

export type CustomerRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  district: string | null;
  postal_code: string | null;
  country: string | null;
  note: string | null;
  total_spent: number | string | null;
  orders_count: number | null;
  is_admin: boolean;
  created_at: string;
  updated_at: string | null;
};

export type CustomerOrderRow = {
  id: string;
  created_at: string;
  status: string;
  fulfillment: string | null;
  payment_method: string | null;
  payment_status: string | null;
  total_price: number | string | null;
};

export function customerName(row: Pick<CustomerRow, "first_name" | "last_name">): string {
  return [row.first_name, row.last_name]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCustomerId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
