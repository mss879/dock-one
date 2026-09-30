/**
 * Contact form rules shared by the form (client) and POST /api/contact (server) — P6/P7: the
 * database (`submit_contact_inquiry`, 12_leads.sql) is the authority and these MIRROR it: name and
 * subject 1–255, message 15–5000 characters after trimming, lengths counted in characters (code
 * points, like Postgres char_length), checked in the same order the function checks them.
 * Plain module (no "use client" / "server-only").
 */

export const CONTACT_LIMITS = { name: 255, email: 254, subject: 255, messageMin: 15, messageMax: 5000 } as const;

/** The emailed reply the desk stores (= contact_inquiries_text_lengths: admin_reply ≤ 10,000). */
export const INQUIRY_REPLY_MAX = 10000;

export type ContactField = "name" | "email" | "subject" | "message";
export type ContactValues = Record<ContactField, string>;
export type ContactErrors = Partial<Record<ContactField, string>>;

/** Copy for each rule — the route maps the SQL codes (invalid_name …) to the same strings. */
export const CONTACT_COPY = {
  invalid_name: "Please enter your name.",
  invalid_email: "Please enter a valid email address.",
  invalid_subject: "Please add a subject.",
  invalid_message: "Messages need 15 to 5,000 characters.",
  nameTooLong: "Names can be up to 255 characters.",
  subjectTooLong: "Subjects can be up to 255 characters.",
  failed: "We couldn't send your message just now. Please try again in a moment.",
} as const;

/** Characters as Postgres counts them (a surrogate pair is one). */
export function charCount(value: string): number {
  return Array.from(value).length;
}

/** = isEmailAddress() in lib/request-guard.ts. */
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Trim like the database does (and collapse runs of whitespace in one-line fields). */
export function normalizeContact(values: Partial<Record<ContactField, unknown>>): ContactValues {
  const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  return {
    name: line(values.name),
    email: line(values.email).toLowerCase(),
    subject: line(values.subject),
    message: typeof values.message === "string" ? values.message.replace(/\r\n?/g, "\n").trim() : "",
  };
}

/** Field errors in the database's order (name → email → subject → message); {} = valid. */
export function validateContact(values: ContactValues): ContactErrors {
  const errors: ContactErrors = {};
  const name = charCount(values.name);
  if (name === 0) errors.name = CONTACT_COPY.invalid_name;
  else if (name > CONTACT_LIMITS.name) errors.name = CONTACT_COPY.nameTooLong;
  if (values.email.length > CONTACT_LIMITS.email || !EMAIL_PATTERN.test(values.email)) errors.email = CONTACT_COPY.invalid_email;
  const subject = charCount(values.subject);
  if (subject === 0) errors.subject = CONTACT_COPY.invalid_subject;
  else if (subject > CONTACT_LIMITS.subject) errors.subject = CONTACT_COPY.subjectTooLong;
  const message = charCount(values.message);
  if (message < CONTACT_LIMITS.messageMin || message > CONTACT_LIMITS.messageMax) errors.message = CONTACT_COPY.invalid_message;
  return errors;
}

export const CONTACT_FIELDS: readonly ContactField[] = ["name", "email", "subject", "message"];
