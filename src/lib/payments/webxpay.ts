import "server-only";
import { constants, createPublicKey, publicDecrypt, publicEncrypt, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { isUsableSecret, serverEnv } from "@/lib/env.server";

/**
 * WebXPay — the card payment gateway (developers.webxpay.com, "Redirect Integration" v3, the
 * mechanism of WebXPay's own WooCommerce/Shopify plugins). Server-only: it holds the merchant
 * keys. The flow (49_card_payments.sql has the database half):
 *
 *   1. The order page asks POST /api/payments/webxpay/start, which opens an attempt
 *      (begin_card_payment) and answers the form below.
 *   2. The browser POSTs that form to WebXPay's checkout. `payment` is "<reference>|<amount>"
 *      RSA-encrypted with the merchant's WebXPay PUBLIC key (PKCS#1 v1.5, as PHP's
 *      openssl_public_encrypt and WebXPay's plugin do — signalled by `enc_method`).
 *   3. WebXPay sends the shopper back to the Return URL set in its portal
 *      (/api/payments/webxpay/webhook) with `payment` (base64 of the plain answer) and
 *      `signature`. The answer is trusted only when the signature verifies against the same
 *      public key — see readWebxpayReturn().
 *
 * WebXPay's public key and the merchant `secret_key` necessarily reach the browser (they are in
 * the form), so anyone can start a WebXPay payment with any reference and amount. The database
 * therefore applies an approved answer only for a reference it issued AND exactly the amount it
 * asked for (mark_order_paid). Never trust "approved" alone.
 */

const HOSTS = { live: "https://webxpay.com", staging: "https://stagingxpay.info" } as const;
const CHECKOUT_ROUTE = "/index.php?route=checkout/billing";
const API_ROUTE = "/index.php?route=api/merchant_api";

/** The `cms` value WebXPay's custom-integration samples (PHP, JS and Node) all send. */
const CMS = "PHP";
/** Sent by WebXPay's PHP sample, JS sample and WooCommerce plugin with a PKCS#1 v1.5-encrypted `payment`. */
const ENC_METHOD = "JCs3J+6oSz4V0LgE0zi/Bg==";
/** The path WebXPay's portal must hold as the Return URL (Settings → Website integration). */
export const WEBXPAY_RETURN_PATH = "/api/payments/webxpay/webhook";

/** Our attempt references (49): the order number plus 12 random hex characters. */
const REFERENCE = /^DO-[0-9]{1,12}-[0-9A-F]{12}$/;

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * The PEM WebXPay's portal shows, however it was pasted into an env var: with real line breaks,
 * with literal "\n", squashed onto one line with spaces, or just the base64 body.
 */
function normalizePem(raw: string): string | null {
  const unescaped = raw.replace(/\\n/g, "\n");
  const rsa = /BEGIN RSA PUBLIC KEY/.test(unescaped);
  const body = unescaped.replace(/-----(BEGIN|END) (RSA )?PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  if (body.length < 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const label = rsa ? "RSA PUBLIC KEY" : "PUBLIC KEY";
  return `-----BEGIN ${label}-----\n${(body.match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;
}

let keyCache: { raw: string; key: KeyObject | null } | null = null;

function publicKey(): KeyObject | null {
  const raw = serverEnv.webxpayPublicKey;
  if (keyCache && keyCache.raw === raw) return keyCache.key;
  let key: KeyObject | null = null;
  const pem = raw ? normalizePem(raw) : null;
  if (pem) {
    try {
      const candidate = createPublicKey({ key: pem, format: "pem", type: pem.includes("RSA PUBLIC KEY") ? "pkcs1" : "spki" });
      key = candidate.asymmetricKeyType === "rsa" ? candidate : null;
    } catch {
      key = null;
    }
  }
  if (raw && !key) console.error("[webxpay] WEBXPAY_PUBLIC_KEY is set but is not a readable RSA public key — card payments are off.");
  keyCache = { raw, key };
  return key;
}

export type WebxpayStatus = {
  /** Every key the card flow needs is present: the checkout may offer card payment. */
  ready: boolean;
  environment: "live" | "staging";
  /** Env var names still missing (or unreadable / too short). */
  missing: string[];
  /** The optional transaction API (admin "Check with WebXPay") has its credentials. */
  lookup: boolean;
};

export function webxpayStatus(): WebxpayStatus {
  const missing: string[] = [];
  if (!serverEnv.webxpaySecretKey) missing.push("WEBXPAY_SECRET_KEY");
  if (!publicKey()) missing.push("WEBXPAY_PUBLIC_KEY");
  if (!isUsableSecret(serverEnv.paymentsSecret)) missing.push("PAYMENTS_SECRET");
  return {
    ready: missing.length === 0,
    environment: serverEnv.webxpayEnvironment,
    missing,
    lookup: Boolean(serverEnv.webxpayApiUsername && serverEnv.webxpayApiPassword && serverEnv.webxpayMerchantNumber),
  };
}

/** True when the server can take card payments (the owner's switch is the other half). */
export function isWebxpayReady(): boolean {
  return webxpayStatus().ready;
}

function host(): string {
  return HOSTS[serverEnv.webxpayEnvironment];
}

/** Amounts as WebXPay's examples write them: "2567.50". */
export function webxpayAmount(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

// ── 1–2. The checkout form ───────────────────────────────────────────────────

export type WebxpayPayer = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  fulfillment: "delivery" | "pickup";
  address: { street: string | null; city: string | null; district: string | null; postalCode: string | null } | null;
};

export type WebxpayForm = { action: string; fields: Record<string, string> };

const clip = (value: string | null | undefined, max: number): string => (value ?? "").replace(/[\u0000-\u001F\u007F|]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The fields WebXPay's checkout expects (Redirect guide §2.2). Names: 30 characters each, both
 * required — the checkout asks card payers for a last name; an older order without one sends
 * the first name twice rather than an invented one. Phone: digits and "+" only (9–20). Address
 * line 1 is required: a showroom-pickup order has none, so it says so.
 */
export function buildWebxpayForm(input: { reference: string; amount: number; payer: WebxpayPayer }): WebxpayForm {
  const key = publicKey();
  if (!key || !serverEnv.webxpaySecretKey) throw new Error("WebXPay is not configured");
  if (!REFERENCE.test(input.reference)) throw new Error("Unexpected payment reference");

  const amount = webxpayAmount(input.amount);
  const payment = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(`${input.reference}|${amount}`, "utf8")).toString("base64");

  const { payer } = input;
  const first = clip(payer.firstName, 30) || clip(payer.email.split("@")[0], 30);
  const last = clip(payer.lastName, 30) || first;
  const address = payer.fulfillment === "delivery" ? payer.address : null;

  const fields: Record<string, string> = {
    first_name: first,
    last_name: last,
    email: payer.email,
    contact_number: payer.phone.replace(/[^\d+]/g, "").slice(0, 20),
    address_line_one: clip(address?.street, 128) || "Showroom pickup",
    city: clip(address?.city, 128),
    state: clip(address?.district, 64),
    postal_code: clip(address?.postalCode, 10),
    country: "Sri Lanka",
    process_currency: "LKR",
    cms: CMS,
    enc_method: ENC_METHOD,
    secret_key: serverEnv.webxpaySecretKey,
    payment,
  };
  for (const name of ["city", "state", "postal_code"] as const) if (!fields[name]) delete fields[name];

  const gateways = serverEnv.webxpayGatewayIds
    .split("|")
    .map((id) => id.trim())
    .filter((id) => /^\d{1,4}$/.test(id));
  if (gateways.length === 1) fields.payment_gateway_id = gateways[0];
  else if (gateways.length > 1) fields.multiple_payment_gateway_ids = gateways.join("|");

  return { action: `${host()}${CHECKOUT_ROUTE}`, fields };
}

// ── 3. WebXPay's answer ──────────────────────────────────────────────────────

export type WebxpayAnswer = {
  /** Our attempt reference (DO-…-…), as WebXPay echoes it. */
  reference: string;
  /** WebXPay's order reference number ("T315972024I13"). */
  gatewayRef: string;
  time: string;
  statusCode: string;
  message: string;
  gatewayId: string;
  /** "12950.00" — the amount WebXPay was asked for, or null when the answer has none. */
  requestedAmount: string | null;
  /** "12950.00" — the amount WebXPay charged, or null when the answer has none. */
  paidAmount: string | null;
  approved: boolean;
};

export type WebxpayReturn = { ok: true; answer: WebxpayAnswer } | { ok: false; reason: "malformed" | "bad_signature" | "unparsable" | "not_configured" };

/** Base64 as it may arrive: a "+" turned into a space by query-string decoding is put back. */
function fromBase64(value: string, maxBytes: number): Buffer | null {
  const clean = value.trim().replace(/ /g, "+").replace(/\s+/g, "");
  if (!clean || clean.length > Math.ceil((maxBytes * 4) / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const bytes = Buffer.from(clean, "base64");
  return bytes.length > 0 && bytes.length <= maxBytes ? bytes : null;
}

/** "1,500.00" / "1500" / "1500.5" → "1500.00"; anything else → null. */
export function canonicalAmount(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/[,\s]/g, "");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) return null;
  return Number(text).toFixed(2);
}

/**
 * Approved, per WebXPay: status 0 / 00 (the Redirect guide's table) — and 10, which WebXPay's
 * own WooCommerce plugin also treats as a success. Partial or short charges are caught by the
 * amount checks in mark_order_paid, not here.
 */
function isApprovedCode(code: string): boolean {
  return /^0{1,3}$/.test(code) || code === "10";
}

/**
 * Verifies and reads the Return URL's `payment` + `signature`. The signature is accepted in
 * either form WebXPay produces: RSA-PSS with SHA-1 and a 20-byte salt (what the signed sample in
 * WebXPay's Node kit verifies with), or the raw PKCS#1 "private-key encryption" of the answer
 * that WebXPay's PHP kit and WooCommerce plugin check with openssl_public_decrypt. Both need
 * WebXPay's private key to produce; anything else is refused.
 *
 * The answer: reference | WebXPay reference | time | status code | comment | gateway id |
 * requested amount | charged amount — e.g.
 * "DO-10050-3F9A1C2B7E4D|T315972024I13|2024-02-13 10:16:28|0|00 - APPROVED|93|100.00|100.00".
 */
export function readWebxpayReturn(paymentB64: string, signatureB64: string): WebxpayReturn {
  const key = publicKey();
  if (!key) return { ok: false, reason: "not_configured" };
  const payment = fromBase64(paymentB64, 1024);
  const signature = fromBase64(signatureB64, 1024);
  if (!payment || !signature) return { ok: false, reason: "malformed" };

  let verified = false;
  try {
    verified = verify("sha1", payment, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 }, signature);
  } catch {
    verified = false;
  }
  if (!verified) {
    try {
      const decrypted = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, signature);
      verified = decrypted.length === payment.length && timingSafeEqual(decrypted, payment);
    } catch {
      verified = false;
    }
  }
  if (!verified) return { ok: false, reason: "bad_signature" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payment);
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  const parts = text.split("|").map((part) => part.trim());
  if (parts.length < 6) return { ok: false, reason: "unparsable" };
  const [rawReference, gatewayRef, time, statusCode] = parts;
  let message: string;
  let gatewayId: string;
  let requested: string | null = null;
  let paid: string | null = null;
  if (parts.length >= 8) {
    paid = parts[parts.length - 1];
    requested = parts[parts.length - 2];
    gatewayId = parts[parts.length - 3];
    message = parts.slice(4, parts.length - 3).join("|");
  } else if (parts.length === 7) {
    requested = parts[6];
    gatewayId = parts[5];
    message = parts[4];
  } else {
    gatewayId = parts[5];
    message = parts[4];
  }
  // WebXPay echoes the order id it was given; tolerate stray characters around it (the signature
  // covers the whole answer, so only WebXPay could have put them there).
  const reference = /DO-[0-9]{1,12}-[0-9A-F]{12}/.exec(rawReference.toUpperCase())?.[0] ?? "";
  if (!REFERENCE.test(reference)) return { ok: false, reason: "unparsable" };

  return {
    ok: true,
    answer: {
      reference,
      gatewayRef: gatewayRef.slice(0, 64),
      time: time.slice(0, 40),
      statusCode: statusCode.slice(0, 16),
      message: message.slice(0, 200),
      gatewayId: gatewayId.slice(0, 16),
      requestedAmount: canonicalAmount(requested),
      paidAmount: canonicalAmount(paid),
      approved: isApprovedCode(statusCode),
    },
  };
}

/** The p_result mark_order_paid / record_card_payment_failure expect (49). */
export function attemptResult(answer: WebxpayAnswer, source: "return" | "lookup"): Record<string, string | null> {
  return {
    requested_amount: answer.requestedAmount,
    paid_amount: answer.paidAmount,
    gateway_ref: answer.gatewayRef || null,
    gateway_status: answer.statusCode || null,
    gateway_message: answer.message || null,
    gateway_id: answer.gatewayId || null,
    gateway_time: answer.time || null,
    source,
  };
}

// ── The transaction API (optional; admin "Check with WebXPay") ──────────────

export type WebxpayTransaction = { approved: boolean; status: string; amount: string | null; gatewayRef: string | null; time: string | null };

export type WebxpayLookup = { ok: false; error: string } | { ok: true; transactions: Map<string, WebxpayTransaction | null> };

const text = (value: unknown, max: number): string | null => (typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) || null : null);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function postForm(path: string, form: Record<string, string>, token?: string): Promise<unknown> {
  const body = new FormData();
  for (const [name, value] of Object.entries(form)) body.append(name, value);
  const response = await fetch(`${host()}${API_ROUTE}/${path}`, {
    method: "POST",
    body,
    headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`WebXPay answered ${response.status} without JSON`);
  }
}

/**
 * Asks WebXPay what happened to our attempts (Merchant API: apiLogin once, then
 * getTransactionByMerchantReference per reference — "store reference" = our attempt reference).
 * Read-only at WebXPay; the caller decides what to record. Approved = WebXPay's `payment_status`
 * "Approved". A reference WebXPay has no transaction for maps to null.
 */
export async function lookupWebxpayTransactions(references: string[]): Promise<WebxpayLookup> {
  if (!webxpayStatus().lookup) return { ok: false, error: "WebXPay's transaction API is not set up on the server (WEBXPAY_API_USERNAME, WEBXPAY_API_PASSWORD, WEBXPAY_MERCHANT_NUMBER)." };
  try {
    const login = await postForm("apiLogin", {
      api_username: serverEnv.webxpayApiUsername,
      api_password: serverEnv.webxpayApiPassword,
      merchant_number: serverEnv.webxpayMerchantNumber,
    });
    const token = isRecord(login) && String(login.status ?? "").toLowerCase() === "success" ? text(login.token, 4000) : null;
    if (!token) return { ok: false, error: "WebXPay refused the API login — check WEBXPAY_API_USERNAME, WEBXPAY_API_PASSWORD and WEBXPAY_MERCHANT_NUMBER." };

    const transactions = new Map<string, WebxpayTransaction | null>();
    for (const reference of references) {
      const answer = await postForm("getTransactionByMerchantReference", { merchant_reference: reference }, token);
      const rows = Array.isArray(answer) ? answer.filter(isRecord) : isRecord(answer) && isRecord(answer.data) ? [answer.data] : isRecord(answer) ? [answer] : [];
      const row = rows.find((r) => /^approved$/i.test(String(r.payment_status ?? "").trim())) ?? rows.find((r) => r.payment_status !== undefined);
      if (!row) {
        transactions.set(reference, null);
        continue;
      }
      const status = text(row.payment_status, 60) ?? "Unknown";
      transactions.set(reference, {
        approved: /^approved$/i.test(status),
        status,
        amount: canonicalAmount(row.total_amount),
        gatewayRef: text(row.order_refference_number ?? row.order_reference_number, 64),
        time: text(row.date_time_transaction, 40),
      });
    }
    return { ok: true, transactions };
  } catch (error) {
    console.error("[webxpay] transaction lookup failed", error instanceof Error ? error.message : error);
    return { ok: false, error: "WebXPay's transaction API did not answer. Try again in a minute." };
  }
}
