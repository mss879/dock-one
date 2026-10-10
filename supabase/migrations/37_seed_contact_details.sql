-- ═════════════════════════════════════════════════════════════════════════════
-- 37_seed_contact_details.sql — Dock One Solutions
--
-- PURPOSE      The client's REAL contact details replace seed 31's placeholders everywhere the
--              storefront shows them (top bar, footer, contact page, checkout pickup, order emails,
--              the tech desk assistant):
--                phone     +94 76 074 4952
--                WhatsApp  +94 76 074 4952   (the same mobile number — change it in admin → Store
--                                             settings if WhatsApp runs on another number)
--                email     info@dockonesolutions.com
--                address   No. 3F14, 3rd Floor, Unity Plaza, Colombo 04  (also the showroom pickup address)
--              and the showroom area in the pickup note and the homepage "Order your way" block
--              (Colombo 03 → Colombo 04), only where they still hold the seeded text.
-- DEPENDS ON   01_foundation (app_config), 03_store_settings, 16_storefront_content.
-- RULES        one atomic DO block guarded by an app_config marker, so later edits in the admin are
--              never overwritten by a re-run; the previous values are printed (NOTICE) for the record.
-- SAFE TO RE-RUN: yes (a second run is a no-op).
-- ═════════════════════════════════════════════════════════════════════════════

DO $seed$
DECLARE
  c_marker  CONSTANT TEXT := 'seed_37_contact_details';
  c_phone   CONSTANT TEXT := '+94 76 074 4952';
  c_email   CONSTANT TEXT := 'info@dockonesolutions.com';
  c_address CONSTANT TEXT := 'No. 3F14, 3rd Floor, Unity Plaza, Colombo 04';
  old       public.store_settings;
  v_n       INT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = c_marker) THEN
    RAISE NOTICE '37_seed_contact_details: already applied (app_config %) — skipped', c_marker;
    RETURN;
  END IF;

  SELECT * INTO old FROM public.store_settings WHERE id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '37_seed_contact_details: the store_settings row is missing — run 03_store_settings.sql first';
  END IF;
  RAISE NOTICE '37_seed_contact_details: replacing phone %, whatsapp %, email %, address %, pickup address %',
    COALESCE(old.phone, '∅'), COALESCE(old.whatsapp, '∅'), COALESCE(old.email, '∅'), COALESCE(old.address, '∅'),
    COALESCE(old.pickup_address, '∅');

  UPDATE public.store_settings SET
    phone          = c_phone,
    whatsapp       = c_phone,
    email          = c_email,
    address        = c_address,
    pickup_address = c_address,
    pickup_note    = CASE WHEN pickup_note = 'Collect in Colombo 03, same day' THEN 'Collect in Colombo 04, same day' ELSE pickup_note END
   WHERE id;

  -- The "Order your way" pickup card still carrying seed 31's text.
  UPDATE public.content_blocks
     SET data = replace(data::TEXT, '"Collect in Colombo 03, same day"', '"Collect in Colombo 04, same day"')::JSONB
   WHERE key = 'order_your_way' AND data::TEXT LIKE '%"Collect in Colombo 03, same day"%';

  -- ── self-check ──────────────────────────────────────────────────────────────
  SELECT count(*)::INT INTO v_n FROM public.store_settings
   WHERE id AND phone = c_phone AND whatsapp = c_phone AND email = c_email AND address = c_address AND pickup_address = c_address;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '37_seed_contact_details: self-check failed — the contact details did not save';
  END IF;

  INSERT INTO public.app_config (name, value) VALUES (c_marker, to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  ON CONFLICT (name) DO NOTHING;
  RAISE NOTICE '37_seed_contact_details: done';
END $seed$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ops notes
-- ─────────────────────────────────────────────────────────────────────────────
-- What the storefront shows now:
--     SELECT phone, whatsapp, email, address, pickup_address, pickup_note FROM public.store_settings;
-- The storefront caches settings: they show within a few minutes, or at once after any save in
-- admin → Store settings.
-- Run it again after changing it (it is guarded by its marker):
--     DELETE FROM public.app_config WHERE name = 'seed_37_contact_details';
