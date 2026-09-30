-- ═════════════════════════════════════════════════════════════════════════════
-- 32_seed_discounts.sql — Dock One Solutions
--
--   ██ DEMO — replace or delete before launch ██
--   The ONE discount code the approved storefront already accepted (src/data/site.ts
--   `promoCodes: { OPENING10: 0.1 }` and the basket's promo field): OPENING10, 10 % off, active,
--   no minimum, no usage limit, no dates, not assistant-only. Nothing else is invented — no other
--   codes, limits or end dates (BUILD_SPEC §3 "Seeds carry only what already exists").
--
--   To remove the demo code (run in the SQL editor; orders that used it keep their
--   discount_code / discount_amount snapshot, only the link is cleared):
--     DELETE FROM public.discounts WHERE upper(code) = 'OPENING10';
--   (or pause it instead: UPDATE public.discounts SET is_active = FALSE WHERE upper(code) = 'OPENING10';)
--   The app_config marker 'seed_32_discounts_demo' stays, so re-running the migrations never
--   brings the code back (delete that row only if you deliberately want to re-seed).
--
-- PURPOSE      Seed OPENING10 so the basket, checkout, quote_order / validate_discount /
--              place_order and the admin Discounts tab have the code the design shows.
-- DEPENDS ON   01_foundation (app_config), 08_discounts, 09_order_rpcs (for verification only).
-- ENABLES      the storefront promo field with a real code; assistant offers list it as a public
--              code (20_assistant_offers).
-- RULES        references the row by code (never a SERIAL id), ON CONFLICT DO NOTHING, one atomic
--              DO block guarded by an app_config marker, self-verifying (RAISE ⇒ rolls back).
-- SAFE TO RE-RUN: yes (a second run is a no-op).
-- ═════════════════════════════════════════════════════════════════════════════

DO $seed$
DECLARE
  c_marker CONSTANT TEXT := 'seed_32_discounts_demo';
  v_inserted INT;
  d public.discounts%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = c_marker) THEN
    RAISE NOTICE '32_seed_discounts: already applied (app_config %) — skipped', c_marker;
    RETURN;
  END IF;

  -- The unique index is on upper(code): an owner-created OPENING10 (any case) is left alone.
  INSERT INTO public.discounts (code, title, kind, value, min_requirement, starts_at, ends_at, usage_limit, is_active, assistant_only)
  VALUES ('OPENING10', 'OPENING10 — 10% off', 'percentage', 10, 0, NULL, NULL, NULL, TRUE, FALSE)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  INSERT INTO public.app_config (name, value) VALUES (c_marker, to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  ON CONFLICT (name) DO NOTHING;

  -- Self-verification.
  SELECT * INTO d FROM public.discounts WHERE upper(code) = 'OPENING10';
  IF NOT FOUND THEN
    RAISE EXCEPTION '32_seed_discounts: OPENING10 is missing after the insert';
  END IF;
  IF v_inserted = 1 THEN
    IF d.code <> 'OPENING10' OR d.kind <> 'percentage' OR d.value <> 10 OR d.min_requirement <> 0
       OR NOT d.is_active OR d.assistant_only OR d.usage_limit IS NOT NULL OR d.usage_count <> 0
       OR d.starts_at IS NOT NULL OR d.ends_at IS NOT NULL THEN
      RAISE EXCEPTION '32_seed_discounts: OPENING10 was not stored as 10 %% off, active, unlimited (got % % %, active %, limit %)',
        d.kind, d.value, d.min_requirement, d.is_active, d.usage_limit;
    END IF;
    IF (public._discount_check('opening10', 10000) ->> 'amount')::NUMERIC <> 1000 THEN
      RAISE EXCEPTION '32_seed_discounts: OPENING10 does not take 10 %% off (validate_discount disagrees)';
    END IF;
    RAISE NOTICE '32_seed_discounts: seeded OPENING10 (10%% off, DEMO)';
  ELSE
    RAISE NOTICE '32_seed_discounts: a code OPENING10 already existed — left unchanged';
  END IF;
END $seed$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 32_seed_discounts (DEMO)
--   Before launch: keep OPENING10 only if you really run that offer (edit or pause it in
--   admin → Discounts), otherwise delete it with the statement in the header.
--   Verification:
--     SELECT code, title, kind, value, min_requirement, usage_limit, usage_count, is_active, assistant_only
--       FROM public.discounts WHERE upper(code) = 'OPENING10';
--     SELECT public.validate_discount('OPENING10', 10000);   -- {"valid": true, "discount_amount": 1000, …}
--     SELECT value FROM public.app_config WHERE name = 'seed_32_discounts_demo';   -- when it ran
-- ═════════════════════════════════════════════════════════════════════════════
