import "server-only";

/**
 * Server-only configuration (secrets and server behaviour). Read once per process.
 * Every variable is documented in `.env.example` with what happens when it is unset.
 */

function read(name: string): string {
  return (process.env[name] ?? "").trim();
}

export const serverEnv = {
  /** Must equal app_config.rate_limit (≥ 20 chars). Unset → every limit fails open (deploy error). */
  rateLimitSecret: read("RATE_LIMIT_SECRET"),
  /** Must equal app_config.cart_recovery. Unset → the recovery job answers 401/503. */
  cartRecoverySecret: read("CART_RECOVERY_SECRET"),
  /** Must equal app_config.maintenance. Authorises the daily /api/maintenance job. */
  maintenanceSecret: read("MAINTENANCE_SECRET"),

  resendApiKey: read("RESEND_API_KEY"),
  resendFromEmail: read("RESEND_FROM_EMAIL"),
  resendReplyTo: read("RESEND_REPLY_TO"),
  orderNotificationEmail: read("ORDER_NOTIFICATION_EMAIL"),

  /** Blueprint §3.3: unset → the assistant answers a friendly "away" message. */
  openaiApiKey: read("OPENAI_API_KEY"),
  /** The ONE default model name lives in lib/assistant/model.ts (WP-I); these are only overrides. */
  assistantModel: read("ASSISTANT_MODEL"),
  assistantVisionModel: read("ASSISTANT_VISION_MODEL"),
  /** `off` disables photo input in the assistant. */
  assistantVisionEnabled: read("ASSISTANT_VISION").toLowerCase() !== "off",

  /** Business time zone for reports and admin aggregate SQL. */
  timezone: read("TIMEZONE") || "Asia/Colombo",
  /** The platform's real client-IP header (Vercel: x-real-ip). */
  clientIpHeader: (read("CLIENT_IP_HEADER") || "x-real-ip").toLowerCase(),
  /** Base-currency (LKR) rates endpoint for display-currency conversion. */
  fxApiUrl: read("FX_API_URL") || "https://open.er-api.com/v6/latest/LKR",
} as const;

export const MIN_SECRET_LENGTH = 20;

/** Mirrors verify_job_secret(): unset or shorter than 20 chars is never valid. */
export function isUsableSecret(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH;
}
