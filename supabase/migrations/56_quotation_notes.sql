-- ═════════════════════════════════════════════════════════════════════════════
-- 56_quotation_notes.sql — Dock One Solutions
--
-- PURPOSE      The client's quotation notes (Website changes, November 2026 — 03 "Quotations.
--              Update Notes / Terms once we confirm the wording"; the wording arrived as
--              "3) Quotation notes.txt"). They are printed, numbered, under NOTES at the bottom of
--              every NEW quotation — made in the admin or requested on the website. Quotations
--              already made keep their own notes.
--
--              The client's file numbers twelve lines, but its line 6 ("or law applies.") is the end
--              of note 5 broken onto a new line, so these are its eleven notes, word for word, except
--              "until stock last" → "until stock lasts" (note 1).
--
--              Note 1 says a quotation is valid for 7 days, so a new quotation's "Valid Until" date
--              is now 7 days after its date (quote_valid_days 14 → 7) — the document never
--              contradicts itself. Both stay editable in admin → a quotation → Template.
--
-- DEPENDS ON   01 (app_config), 26 (invoice_settings), 40 (quote_notes, quote_valid_days).
-- SAFE TO RE-RUN: yes — applied once (marker 'docs_56_quote_notes'); a re-run never overwrites
--              later edits made in the admin.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = 'docs_56_quote_notes') THEN
    RETURN;
  END IF;
  UPDATE public.invoice_settings
     SET quote_notes = ARRAY[
           'This quotation is valid for 7 days from the quotation date or until stock lasts.',
           'The payment due date and any advance payment must be agreed before the order is confirmed. Send payment confirmation to info@dockonesolutions.com with your quotation number.',
           'The delivery or collection date will be confirmed when we accept your order. Delivery charges will be shown separately, and we will inform you of any delay.',
           'Only the listed services are included. Installation, setup, software, and data transfer are included only if listed. We will obtain your approval before supplying a different model or item.',
           'The warranty period and provider will be stated for each item. Normal use or depletion of consumable items is not covered. Manufacturing faults remain covered where the warranty or law applies.',
           'Damage caused by misuse, liquid spills, power surges, or unauthorised repairs is not covered, where permitted by law.',
           'Please check all items upon receipt and report any damage, missing items, incorrect items, or faults as soon as possible. This does not affect your rights for faults found later.',
           'Keep your invoice or other proof of purchase throughout the warranty period. Contact us for help with a claim.',
           'Approved returns receive store credit only.',
           'Confirm your order in writing with the quotation number, item details, and quantities. Any changes to prices, items, or terms must be agreed by both parties in writing.',
           'For inquiries, contact +94 71 096 0006 | info@dockonesolutions.com'],
         quote_valid_days = 7
   WHERE id;
  INSERT INTO public.app_config (name, value) VALUES ('docs_56_quote_notes', 'set') ON CONFLICT (name) DO NOTHING;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 56_quotation_notes
--   Run after 40 (any time; no code depends on it). From then on every new quotation prints the
--   client's eleven notes and is valid for 7 days.
--   Verification:
--     SELECT quote_valid_days, cardinality(quote_notes), quote_notes[1] FROM public.invoice_settings;   -- 7 | 11 | This quotation is valid for 7 days …
-- ═════════════════════════════════════════════════════════════════════════════
