-- Fixture for test files written against the DEMO-only catalogue (migrations 04–33): in this test's
-- private database copy, undo 34_seed_inventory — drop the real catalogue and its five departments,
-- and switch the demo products and collections back on — so those files test their own migration
-- exactly as designed. 34_seed_inventory.test.sql covers the real catalogue.
-- Likewise it puts back seed 31's placeholder contact details that 37_seed_contact_details replaced
-- (37_seed_contact_details.test.sql covers the real ones).
DO $fixture$
BEGIN
  IF to_regclass('public.variant_sourcing') IS NOT NULL THEN
    DELETE FROM public.products p
     WHERE EXISTS (SELECT 1 FROM public.product_variants v JOIN public.variant_sourcing s ON s.variant_id = v.id
                    WHERE v.product_id = p.id);
  END IF;
  DELETE FROM public.categories c
   WHERE c.id IN ('monitors', 'audio', 'power-charging', 'cameras', 'components')
     AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.category_id = c.id);
  UPDATE public.categories SET name = 'Mice', tagline = 'Ergonomic, gaming & travel'
   WHERE id = 'mice' AND name = 'Mice & Mousepads';
  UPDATE public.products SET is_active = TRUE
   WHERE slug IN ('vanta-g15-gaming-laptop', 'aeroslim-14-ultrabook', 'forge-studio-16-creator-laptop',
                  'campus-13-everyday-laptop', 'bolt-x-portable-ssd-1tb', 'atlas-slim-external-hdd-2tb',
                  'duolink-flash-drive-128gb', 'vault-desktop-backup-drive-8tb',
                  'kairo-75-wireless-mechanical-keyboard', 'onyx-pro-full-size-rgb-keyboard',
                  'feather-slim-wireless-keyboard', 'volt-60-compact-keyboard-acid-lime',
                  'glide-mx-ergonomic-wireless-mouse', 'aero-lite-gaming-mouse-58g',
                  'grip-vertical-ergonomic-mouse', 'pebble-go-travel-mouse')
     AND NOT is_active;
  UPDATE public.collections SET is_active = TRUE
   WHERE id IN ('work-from-home', 'gaming-zone', 'campus-kit', 'creator-studio') AND NOT is_active;
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_37_contact_details') THEN
    UPDATE public.store_settings
       SET phone = '+94 11 234 5678', whatsapp = '+94 77 123 4567', email = 'hello@dockone.lk',
           address = 'No. 42, Galle Road, Colombo 03', pickup_address = 'No. 42, Galle Road, Colombo 03',
           pickup_note = 'Collect in Colombo 03, same day'
     WHERE id;
    UPDATE public.content_blocks
       SET data = replace(data::text, '"Collect in Colombo 04, same day"', '"Collect in Colombo 03, same day"')::jsonb
     WHERE key = 'order_your_way';
  END IF;
END $fixture$;
