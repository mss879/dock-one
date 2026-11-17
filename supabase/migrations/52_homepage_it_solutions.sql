-- ═════════════════════════════════════════════════════════════════════════════
-- 52_homepage_it_solutions.sql — Dock One Solutions
--
-- PURPOSE      The client asked (Website changes, November 2026 — 01 Frontend, "Homepage") for the
--              homepage copy and featured sections to cover all product categories and IT
--              solutions. The category parts are code (every active category already has its card,
--              and the new "Top picks by category" section lists each one's products). This file
--              adds the IT solutions section's words as a homepage block, `it_solutions`, edited in
--              admin → Homepage & navbar → Content blocks → IT solutions.
--
--              The starting copy states only what the store already does and says elsewhere
--              (the categories it sells, formal quotations, official warranty, island-wide
--              delivery). The services the client offers under "IT solutions" are for the client
--              to list (docs/client/Dock-One-November-Changes-Client-Questions.pdf, A6) — replace or extend
--              the items in the admin.
--
--              Shape (zod schema `itSolutionsSchema` in src/components/home/content-model.ts):
--                {eyebrow, title, body, items: [{title, text, href}] (≤ 6), cta: {label, href}}
--
-- DEPENDS ON   16 (content_blocks), 01 (app_config).
-- SAFE TO RE-RUN: yes — created once (marker 'seed_52_it_solutions'); a re-run never overwrites the
--              owner's edits or brings back a block the owner deleted.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_52_it_solutions') THEN
    RETURN;
  END IF;
  INSERT INTO public.content_blocks (key, data)
  VALUES ('it_solutions', jsonb_build_object(
    'eyebrow', 'For businesses',
    'title',   'IT solutions for your business',
    'body',    'Equipping an office, a classroom or a growing team? Tell us what you need and we will send you a formal quotation — laptops, monitors, networking, storage and accessories from one place, with official warranty and island-wide delivery.',
    'items', jsonb_build_array(
      jsonb_build_object('title', 'Laptops for every role',   'text', 'Everyday work machines through to creator and gaming laptops.', 'href', '/shop?category=laptops'),
      jsonb_build_object('title', 'Monitors & workspace',     'text', 'Monitors, keyboards, mice and the accessories that finish a desk.', 'href', '/shop?category=monitors'),
      jsonb_build_object('title', 'Networking & components',  'text', 'Wi-Fi adapters, memory and parts to upgrade what you already have.', 'href', '/shop?category=components'),
      jsonb_build_object('title', 'Storage & backup',         'text', 'SSDs, hard drives and flash storage for the files that matter.', 'href', '/shop?category=storage'),
      jsonb_build_object('title', 'Power & connectivity',     'text', 'Chargers, power banks, cables and adapters.', 'href', '/shop?category=power-charging'),
      jsonb_build_object('title', 'Bulk & business orders',   'text', 'One quotation, one invoice and delivery island-wide.', 'href', '/quote')),
    'cta', jsonb_build_object('label', 'Talk to us', 'href', '/contact')))
  ON CONFLICT (key) DO NOTHING;
  INSERT INTO public.app_config (name, value) VALUES ('seed_52_it_solutions', 'created') ON CONFLICT (name) DO NOTHING;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 52_homepage_it_solutions
--   Run after the deploy that brings the IT solutions section (before it, the block is stored but
--   nothing shows it). Edit it in admin → Homepage & navbar → Content blocks → IT solutions.
--   Verification:
--     SELECT data ->> 'title', jsonb_array_length(data -> 'items') FROM public.content_blocks WHERE key = 'it_solutions';
-- ═════════════════════════════════════════════════════════════════════════════
