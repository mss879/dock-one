-- 37_seed_contact_details.test.sql — the client's real contact details are in store_settings, the
-- seeded Colombo 03 pickup text now says Colombo 04, and a re-run never overwrites later edits.
\ir _helpers.sql

SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', phone, whatsapp, email, address, pickup_address) FROM public.store_settings),
                  '+94 76 074 4952|+94 76 074 4952|info@dockonesolutions.com|No. 3F14, 3rd Floor, Unity Plaza, Colombo 04|No. 3F14, 3rd Floor, Unity Plaza, Colombo 04',
                  'phone, WhatsApp, email, address and pickup address are the real ones');
SELECT pg_temp.eq((SELECT pickup_note FROM public.store_settings), 'Collect in Colombo 04, same day', 'the pickup note names Colombo 04');
SELECT pg_temp.ok((SELECT data::text NOT LIKE '%Colombo 03%' FROM public.content_blocks WHERE key = 'order_your_way'),
                  'the "Order your way" block no longer says Colombo 03');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_37_contact_details'), 'the marker is set');

-- a later edit in the admin survives running the file again
UPDATE public.store_settings SET phone = '+94 77 000 0000' WHERE id;
\ir ../migrations/37_seed_contact_details.sql
SELECT pg_temp.eq((SELECT phone FROM public.store_settings), '+94 77 000 0000', 're-running 37 never overwrites a later edit');
