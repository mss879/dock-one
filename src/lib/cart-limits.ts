/**
 * Basket limits shared by the browser (lib/cart.ts) and the server (lib/checkout.ts).
 * A plain module — no "use client", no "server-only" — so route handlers can import it.
 * Mirrors c_max_qty / c_max_lines in place_order + quote_order (09_order_rpcs.sql). Change both together (P7).
 */
export const MAX_QTY = 10;
export const MAX_LINES = 50;
