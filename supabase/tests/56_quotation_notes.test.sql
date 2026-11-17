-- 56_quotation_notes.test.sql — the client's quotation notes: the eleven notes in order (the broken
-- line joined back into note 5), valid for 7 days, used by a new website quotation request, within
-- the notes' limits, and never written over by a re-run.
\ir _helpers.sql

SELECT pg_temp.eq((SELECT cardinality(quote_notes) FROM public.invoice_settings), 11, 'eleven notes');
SELECT pg_temp.eq((SELECT quote_notes[1] FROM public.invoice_settings), 'This quotation is valid for 7 days from the quotation date or until stock lasts.',
                  'note 1 says 7 days');
SELECT pg_temp.ok((SELECT quote_notes[5] LIKE '%where the warranty or law applies.' FROM public.invoice_settings),
                  'the line the client''s file broke ("or law applies.") is back inside note 5');
SELECT pg_temp.ok((SELECT NOT EXISTS (SELECT 1 FROM unnest(quote_notes) n WHERE n ~ '^\s*\d+[.)]' OR n ~ '^or law') FROM public.invoice_settings),
                  'no note carries its own number (the document numbers them)');
SELECT pg_temp.eq((SELECT quote_notes[11] FROM public.invoice_settings), 'For inquiries, contact +94 71 096 0006 | info@dockonesolutions.com', 'the last note is the contact line');
SELECT pg_temp.ok((SELECT bool_and(char_length(n) BETWEEN 1 AND 500) FROM public.invoice_settings, unnest(quote_notes) n), 'each note fits the 500-character limit');
SELECT pg_temp.eq((SELECT quote_valid_days FROM public.invoice_settings), 7, 'a new quotation is valid for 7 days');

-- a quotation requested on the website starts with them
INSERT INTO public.categories (id, name) VALUES ('qn-cat', 'Quote note tests');
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('qn-thing', 'QnBrand', 'Qn Thing', 'qn-cat');
INSERT INTO public.product_variants (product_id, sku, name, price) SELECT id, 'QN-1', 'Standard', 1000 FROM public.products WHERE slug = 'qn-thing';
SELECT pg_temp.login_anon();
SELECT set_config('t.q', public.request_quotation('{"name":"Nadee","email":"nadee@example.lk","phone":"0771234567"}',
                  jsonb_build_array(jsonb_build_object('variant_id', (SELECT id FROM public.product_variants WHERE sku = 'QN-1'), 'quantity', 1)))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s', cardinality(notes), valid_until - issue_date) FROM public.invoices WHERE id = (current_setting('t.q')::jsonb ->> 'id')::int),
                  '11|7', 'a website quotation request prints the eleven notes and is valid for 7 days');

-- applied once: later edits in the admin survive a re-run
UPDATE public.invoice_settings SET quote_notes = ARRAY['Our own wording.'], quote_valid_days = 10 WHERE id;
\ir ../migrations/56_quotation_notes.sql
SELECT pg_temp.eq((SELECT format('%s|%s', array_to_string(quote_notes, '/'), quote_valid_days) FROM public.invoice_settings), 'Our own wording.|10',
                  'a re-run keeps the owner''s edits');
