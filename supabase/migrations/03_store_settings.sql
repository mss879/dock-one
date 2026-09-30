-- ═════════════════════════════════════════════════════════════════════════════
-- 03_store_settings.sql — Dock One Solutions
--
-- PURPOSE      The singleton `store_settings` row: the delivery rule (fee + free-delivery
--              threshold), which payment methods are on, showroom pickup, the bank account for
--              bank transfer, contact details, socials, top-bar announcement, ticker, footer
--              payment labels, the flash-sale title/end time, returns window and warranty note.
--              BUILD_SPEC §1 (SHIPPING_RULE, PAYMENT_METHODS), §4.2, §6.
-- DEPENDS ON   01_foundation, 02_customers_and_auth (is_admin(), customers for updated_by).
-- ENABLES      lib/settings.ts + useStoreSettings() (storefront chrome, cart/checkout previews),
--              place_order / quote_order in 09 (read the SAME row — the DB is the authority on
--              the delivery fee), admin Settings/Homepage tabs (WP-B).
-- NOTE         The row is created here with column defaults only, plus the store's real bank
--              account (given by the owner, 2026-09-28). The demo values the client sees
--              (contact, socials, ticker, labels…) are seeded by 31_seed_storefront.sql.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.store_settings (
  id                         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),   -- singleton
  store_name                 TEXT NOT NULL DEFAULT 'Dock One Solutions',
  -- Delivery rule. place_order: fee = 0 for pickup, else 0 when the PRE-discount subtotal
  -- >= free_delivery_threshold, else delivery_fee. NULL threshold = delivery is never free.
  delivery_fee               NUMERIC(10,2) NOT NULL DEFAULT 450,
  free_delivery_threshold    NUMERIC(12,2) DEFAULT 15000,
  -- Payments (no card fields anywhere: COD + bank transfer only).
  cod_enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  cod_max_total              NUMERIC(12,2),                 -- NULL = no cap on COD orders
  bank_transfer_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  -- The account shoppers pay into (checkout, order page, confirmation email). Bank transfer is
  -- offered only while the account name, bank and account number are all set (09).
  bank_account_name          TEXT,
  bank_name                  TEXT,
  bank_branch                TEXT,                          -- optional
  bank_account_number        TEXT,                          -- digits, optionally grouped by spaces/hyphens
  bank_transfer_instructions TEXT,                          -- optional extra note shown under the account
  -- Showroom pickup.
  pickup_enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  pickup_address             TEXT,
  pickup_note                TEXT,
  -- Contact + legal: every one nullable and rendered ONLY when set (P15: never invent).
  phone                      TEXT,
  whatsapp                   TEXT,
  email                      TEXT,
  address                    TEXT,
  map_url                    TEXT,
  opening_hours              TEXT,
  business_reg_no            TEXT,
  socials                    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {facebook|instagram|tiktok|youtube: "https://…"}
  -- Chrome copy.
  announcement               TEXT,                          -- top-bar override
  ticker_items               TEXT[] NOT NULL DEFAULT '{}',
  accepted_payment_labels    TEXT[] NOT NULL DEFAULT '{}',  -- footer "We accept"
  -- Flash sale: the countdown counts to a REAL end time; the section hides when NULL or past.
  flash_sale_title           TEXT,
  flash_sale_ends_at         TIMESTAMPTZ,
  -- Policies.
  returns_window_days        INT NOT NULL DEFAULT 7,
  warranty_note              TEXT,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                 UUID REFERENCES public.customers (id) ON DELETE SET NULL
);

-- The bank-account columns (2026-09-28): the CREATE above has them on a fresh database; this adds
-- them to a table created by an earlier version of this file.
ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS bank_account_name   TEXT,
  ADD COLUMN IF NOT EXISTS bank_name           TEXT,
  ADD COLUMN IF NOT EXISTS bank_branch         TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT;

-- Named constraints (the admin form maps a violation to a field by name). Text limits equal
-- the display caps in src/lib/settings-shared.ts, so nothing saved is ever cut on screen.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_money_valid') THEN
    ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_money_valid CHECK (
          delivery_fee >= 0 AND delivery_fee <= 100000
      AND (free_delivery_threshold IS NULL OR free_delivery_threshold >= 0)
      AND (cod_max_total IS NULL OR cod_max_total > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_returns_window_valid') THEN
    ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_returns_window_valid
      CHECK (returns_window_days BETWEEN 0 AND 365);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_socials_valid') THEN
    -- Only the four known networks, each an https URL without spaces or backslashes
    -- (rendered as a link: no javascript: URLs, no "\" host tricks).
    ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_socials_valid CHECK (
          jsonb_typeof(socials) = 'object'
      AND (socials - ARRAY['facebook', 'instagram', 'tiktok', 'youtube']) = '{}'::jsonb
      AND NOT jsonb_path_exists(socials, '$.* ? (@.type() != "string")')
      AND NOT jsonb_path_exists(socials, '$.* ? (!(@ like_regex "^https://[^\\s\\\\]+$"))'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_urls_valid') THEN
    ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_urls_valid
      CHECK (map_url IS NULL OR map_url ~ '^https://[^\\\s]+$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_email_valid') THEN
    ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_email_valid
      CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_lists_valid') THEN
    -- ≤ 20 ticker items of ≤ 200 chars, ≤ 12 payment labels of ≤ 60 chars, no NULLs.
    ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_lists_valid CHECK (
          cardinality(ticker_items) <= 20
      AND cardinality(accepted_payment_labels) <= 12
      AND array_position(ticker_items, NULL) IS NULL
      AND array_position(accepted_payment_labels, NULL) IS NULL
      AND NOT jsonb_path_exists(to_jsonb(ticker_items), '$[*] ? (@ like_regex "^.{201}" flag "s")')
      AND NOT jsonb_path_exists(to_jsonb(accepted_payment_labels), '$[*] ? (@ like_regex "^.{61}" flag "s")'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_text_lengths') THEN
    ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_text_lengths CHECK (
          char_length(store_name) BETWEEN 1 AND 120
      AND (bank_transfer_instructions IS NULL OR char_length(bank_transfer_instructions) <= 2000)
      AND (pickup_address  IS NULL OR char_length(pickup_address)  <= 500)
      AND (pickup_note     IS NULL OR char_length(pickup_note)     <= 500)
      AND (phone           IS NULL OR char_length(phone)           <= 40)
      AND (whatsapp        IS NULL OR char_length(whatsapp)        <= 40)
      AND (address         IS NULL OR char_length(address)         <= 500)
      AND (map_url         IS NULL OR char_length(map_url)         <= 500)
      AND (opening_hours   IS NULL OR char_length(opening_hours)   <= 500)
      AND (business_reg_no IS NULL OR char_length(business_reg_no) <= 80)
      AND (announcement    IS NULL OR char_length(announcement)    <= 200)
      AND (flash_sale_title IS NULL OR char_length(flash_sale_title) <= 120)
      AND (warranty_note   IS NULL OR char_length(warranty_note)   <= 1000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_settings_bank_account_valid') THEN
    -- Name, bank and branch: one line of 1–120 characters. The account number: 4–40 characters of
    -- digits, optionally grouped by single spaces or hyphens (what a shopper types into a banking app).
    ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_bank_account_valid CHECK (
          (bank_account_name IS NULL OR (btrim(bank_account_name) <> '' AND char_length(bank_account_name) <= 120
                                         AND bank_account_name !~ '[[:cntrl:]]'))
      AND (bank_name         IS NULL OR (btrim(bank_name) <> '' AND char_length(bank_name) <= 120
                                         AND bank_name !~ '[[:cntrl:]]'))
      AND (bank_branch       IS NULL OR (btrim(bank_branch) <> '' AND char_length(bank_branch) <= 120
                                         AND bank_branch !~ '[[:cntrl:]]'))
      AND (bank_account_number IS NULL OR (char_length(bank_account_number) BETWEEN 4 AND 40
                                           AND bank_account_number ~ '^[0-9]+([ -][0-9]+)*$')));
  END IF;
END $$;

-- Touch: updated_at always, updated_by = the admin who saved (NULL for SQL-editor edits).
CREATE OR REPLACE FUNCTION public.store_settings_touch() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.store_settings_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS store_settings_touch ON public.store_settings;
CREATE TRIGGER store_settings_touch BEFORE UPDATE ON public.store_settings
  FOR EACH ROW EXECUTE FUNCTION public.store_settings_touch();

-- RLS: everyone reads the one row; only admins update it; nobody inserts or deletes.
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.store_settings FROM anon, authenticated;
GRANT SELECT ON TABLE public.store_settings TO anon, authenticated;
GRANT UPDATE ON TABLE public.store_settings TO authenticated;

DROP POLICY IF EXISTS store_settings_public_read ON public.store_settings;
CREATE POLICY store_settings_public_read ON public.store_settings
  FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS store_settings_admin_update ON public.store_settings;
CREATE POLICY store_settings_admin_update ON public.store_settings
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

-- The singleton row, column defaults only.
INSERT INTO public.store_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- The store's bank account for bank transfer — REAL details, given by the owner on 2026-09-28.
-- Written only while the row holds no bank details at all, so an edit made in admin → Store
-- settings is never overwritten by a re-run (and a re-run never touches updated_at).
UPDATE public.store_settings
   SET bank_account_name   = 'Dock One Solutions Pvt Ltd',
       bank_name           = 'Bank of Ceylon',
       bank_branch         = 'Vishaka',
       bank_account_number = '79503030'
 WHERE id
   AND bank_account_name IS NULL AND bank_name IS NULL AND bank_branch IS NULL AND bank_account_number IS NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 03_store_settings
--   The storefront, the cart previews and place_order all read THIS row; change the delivery
--   rule here (admin Settings tab) and every surface follows — no code change, no migration.
--   Bank transfer: this file fills the store's bank account (Dock One Solutions Pvt Ltd, Bank of
--   Ceylon, Vishaka branch, account 79503030) when none is set — check it in admin → Store
--   settings; bank transfer is offered only while the account name, bank and account number are
--   set. Already applied an earlier 03? Re-run this file (it adds the four bank columns and fills
--   them), then re-run 09 so the checkout uses them.
--   Before launch: set real contact details and pickup_address (or switch pickup_enabled off) —
--   seed 31 fills demo values. Anything left NULL is simply not rendered.
--   Verification:
--     SELECT count(*) FROM public.store_settings;                          -- exactly 1
--     SELECT delivery_fee, free_delivery_threshold, cod_enabled, bank_transfer_enabled
--       FROM public.store_settings;                                        -- 450.00, 15000.00, t, t by default
--     SELECT bank_account_name, bank_name, bank_branch, bank_account_number
--       FROM public.store_settings;       -- Dock One Solutions Pvt Ltd | Bank of Ceylon | Vishaka | 79503030
--     -- live probe: anon can read, cannot write
--     curl -s "$SUPABASE_URL/rest/v1/store_settings?select=delivery_fee" -H "apikey: $ANON"
--     curl -s -X PATCH "$SUPABASE_URL/rest/v1/store_settings?id=eq.true" -H "apikey: $ANON" \
--          -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" -d '{"delivery_fee":0}'  -- 401/permission denied
-- ═════════════════════════════════════════════════════════════════════════════
