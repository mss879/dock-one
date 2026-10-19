"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Who is signed in to the admin and what they may open (39_staff_accounts): the owner ("admin")
 * sees everything; a staff member only the sections ticked for them, each view or edit. The
 * database enforces the same rules on every request — this only shapes the screens (hidden tabs,
 * read-only notes, buttons staff can't use).
 */

export type AdminRole = "admin" | "staff";
export type AccessLevel = "view" | "edit";
export type AdminAccess = { role: AdminRole; name: string; email: string; permissions: Record<string, AccessLevel> };

/** The sections a staff member can be given (the admin tabs, plus cost prices). */
export const STAFF_AREAS: readonly { key: string; label: string; hint?: string }[] = [
  { key: "dashboard", label: "Dashboard", hint: "Sales figures" },
  { key: "orders", label: "Orders" },
  { key: "invoices", label: "Invoices" },
  { key: "quotations", label: "Quotations" },
  { key: "receipts", label: "Receipts" },
  { key: "expenses", label: "Expenses" },
  { key: "discounts", label: "Discounts" },
  { key: "abandoned-carts", label: "Abandoned carts" },
  { key: "reports", label: "Reports", hint: "Sales, stock value and movement figures" },
  { key: "products", label: "Products" },
  { key: "categories", label: "Categories" },
  { key: "collections", label: "Collections" },
  { key: "inventory", label: "Inventory", hint: "Edit = change stock and record movements" },
  { key: "suppliers", label: "Suppliers", hint: "Supplier details and supplier warranties" },
  { key: "warranty", label: "Warranty" },
  { key: "reviews", label: "Reviews" },
  { key: "customers", label: "Customers" },
  { key: "inquiries", label: "Inquiries" },
  { key: "subscribers", label: "Subscribers" },
  { key: "finder-insights", label: "Finder insights" },
  { key: "assistant-insights", label: "Assistant insights" },
  { key: "homepage", label: "Homepage" },
  { key: "content", label: "Pages & blog" },
  { key: "settings", label: "Store settings" },
  { key: "site-lock", label: "Site lock" },
  { key: "costs", label: "Cost prices", hint: "See (view) or change (edit) what items cost the store" },
];

/** The owner's suggested starting point for counter staff (the client's restrictions). */
export const STANDARD_STAFF_PERMISSIONS: Record<string, AccessLevel> = {
  orders: "edit",
  invoices: "edit",
  quotations: "edit",
  receipts: "edit",
  inventory: "view",
  warranty: "view",
  customers: "view",
  inquiries: "edit",
};

const FULL: AdminAccess = { role: "admin", name: "", email: "", permissions: {} };
const AccessContext = createContext<AdminAccess>(FULL);

export function AdminAccessProvider({ access, children }: { access: AdminAccess; children: ReactNode }) {
  return <AccessContext.Provider value={access}>{children}</AccessContext.Provider>;
}

export type AccessHelpers = AdminAccess & {
  isAdmin: boolean;
  /** At least `level` on `area` (an admin always). */
  can: (area: string, level?: AccessLevel) => boolean;
};

export function accessHelpers(access: AdminAccess): AccessHelpers {
  const isAdmin = access.role === "admin";
  return {
    ...access,
    isAdmin,
    can: (area, level = "view") => {
      if (isAdmin) return true;
      const have = access.permissions[area];
      return level === "view" ? have === "view" || have === "edit" : have === "edit";
    },
  };
}

export function useAdminAccess(): AccessHelpers {
  const access = useContext(AccessContext);
  return useMemo(() => accessHelpers(access), [access]);
}
