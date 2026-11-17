-- 57_dealer_commission_delivery_notes.test.sql — the dealer on an invoice (name, commission in rupees
-- or %, who may set it, the checks, quotations ignore it, paid = final for staff, void), the names
-- suggested, the dealers in the commission report (grouping, arithmetic, what counts), delivery notes
-- (issued invoices only, numbering, filled from the invoice, updates, checks, staff and RLS access,
-- paid invoices, void invoices, owner-only delete) and a re-run.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner57@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper57@shop.test')::text, false);

INSERT INTO public.categories (id, name) VALUES ('qa57-cat', 'QA 57');
INSERT INTO public.products (slug, brand, name, category_id) VALUES
  ('qa57-laptop', 'QaBrand', 'Qa57 Laptop', 'qa57-cat'), ('qa57-mouse', 'QaBrand', 'Qa57 Mouse', 'qa57-cat');
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT p.id, v.sku, 'Standard', v.price FROM public.products p
  JOIN (VALUES ('qa57-laptop', 'Q57-LT', 200000), ('qa57-mouse', 'Q57-MS', 4000)) AS v(slug, sku, price) ON v.slug = p.slug;
INSERT INTO public.inventory (variant_id, stock_level) SELECT id, 30 FROM public.product_variants WHERE sku IN ('Q57-LT', 'Q57-MS');

CREATE FUNCTION pg_temp.vid(p_sku text) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.product_variants WHERE sku = p_sku $$;
CREATE FUNCTION pg_temp.inv(p_name text) RETURNS public.invoices LANGUAGE sql AS $$ SELECT * FROM public.invoices WHERE id = current_setting('t.' || p_name)::int $$;
CREATE FUNCTION pg_temp.dn(p_name text) RETURNS public.delivery_notes LANGUAGE sql AS $$ SELECT * FROM public.delivery_notes WHERE invoice_id = current_setting('t.' || p_name)::int $$;
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;
-- an invoice draft: a laptop and a free mouse, discount Rs. 10,000 → sales before VAT Rs. 190,000
CREATE FUNCTION pg_temp.draft(p_client text, p_sale jsonb, p_doc jsonb DEFAULT '{"doc_type":"invoice"}') RETURNS int LANGUAGE sql AS $$
  SELECT (public.admin_save_document(jsonb_build_object('bill_to_name', p_client, 'bill_to_phone', '077 111 2222',
                                                        'bill_to_address', E'No. 5, Flower Road\nKollupitiya', 'bill_to_city', 'Colombo',
                                                        'bill_to_postal_code', '00300', 'discount_type', 'amount', 'discount_value', 10000),
            jsonb_build_array(jsonb_build_object('variant_id', pg_temp.vid('Q57-LT'), 'description', 'Qa57 Laptop', 'quantity', 1, 'unit_price', 200000),
                              jsonb_build_object('variant_id', pg_temp.vid('Q57-MS'), 'description', 'Qa57 Mouse', 'quantity', 1, 'unit_price', 0)),
            p_sale, p_doc) #>> '{invoice,id}')::int
$$;
CREATE FUNCTION pg_temp.dealer(p_name text, p_doc jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.' || p_name)::int), NULL, NULL, p_doc)
$$;
CREATE FUNCTION pg_temp.today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Asia/Colombo')::date $$;

-- ── 1. the dealer on an invoice ─────────────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.invoices WHERE dealer_name IS NOT NULL OR dealer_commission_value <> 0), 0::bigint,
                  'invoices already made have no dealer');
SELECT pg_temp.eq(public._invoice_dealer_commission('percent', 2.5, 190000), 4750.00, '2.5% of Rs. 190,000 (before VAT, after discount) is Rs. 4,750');
SELECT pg_temp.eq(public._invoice_dealer_commission('amount', 3000, 190000), 3000::numeric, 'an amount is the amount');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public._invoice_dealer_commission('amount', 1, 1)$$, '42501', 'the helper is internal (no API access)');
SELECT set_config('t.clerk', public.admin_create_staff('clerk57@shop.test', 'Counter2026', 'Kasun', '{"invoices": "edit"}') ->> 'user_id', false);
SELECT set_config('t.viewer', public.admin_create_staff('view57@shop.test', 'Counter2026', 'Viewer', '{"invoices": "view"}') ->> 'user_id', false);
SELECT set_config('t.a', pg_temp.draft('Dealer Client A', '{"sale_type":"credit","credit_days":30}')::text, false);
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('a')).dealer_name, (pg_temp.inv('a')).dealer_commission_type, (pg_temp.inv('a')).dealer_commission_value),
                  '|amount|0.00', 'a new invoice has no dealer (commission Rs. 0)');
SELECT pg_temp.dealer('a', '{"dealer_name": "  ABC Computers ", "dealer_commission_type": "amount", "dealer_commission_value": 5000}');
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('a')).dealer_name, (pg_temp.inv('a')).dealer_commission_type, (pg_temp.inv('a')).dealer_commission_value),
                  'ABC Computers|amount|5000.00', 'the owner names the dealer who sent the customer and a commission in rupees (name trimmed)');
SELECT pg_temp.dealer('a', '{"dealer_commission_type": "percent", "dealer_commission_value": 2.5}');
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('a')).dealer_name, (pg_temp.inv('a')).dealer_commission_type, (pg_temp.inv('a')).dealer_commission_value),
                  'ABC Computers|percent|2.50', 'or as a % (the name is kept when not sent)');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_commission_value": 150}')$$, current_setting('t.a')), '22023',
                      'a % above 100 is refused', 'invalid_invoice:A dealer''s commission in % is from 0 to 100.');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_commission_type": "cash"}')$$, current_setting('t.a')), '22023',
                      'the commission is an amount or a %', 'invalid_invoice:The dealer''s commission is an amount in rupees or a percentage.');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_name": null, "dealer_commission_value": 100}')$$, current_setting('t.a')), '22023',
                      'a commission needs the dealer''s name', 'invalid_invoice:Name the dealer the commission is for.');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_name": null}')$$, current_setting('t.a')), '22023',
                      'clearing the name while a commission is set is refused too', 'invalid_invoice:Name the dealer%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_commission_value": -5}')$$, current_setting('t.a')), '22023',
                      'a negative commission is refused', 'invalid_invoice:The dealer''s commission must be an amount%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_commission_type": "amount", "dealer_commission_value": 100000001}')$$, current_setting('t.a')), '22023',
                      'at most Rs. 100,000,000', 'invalid_invoice:The dealer''s commission can be at most%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_name": "%s"}')$$, current_setting('t.a'), repeat('x', 121)), '22023',
                      'a dealer''s name is at most 120 characters', 'invalid_invoice:The dealer can be at most 120 characters.');
SELECT pg_temp.dealer('a', '{"dealer_name": null, "dealer_commission_type": "amount", "dealer_commission_value": 0}');
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('a')).dealer_name, (pg_temp.inv('a')).dealer_commission_type, (pg_temp.inv('a')).dealer_commission_value),
                  '|amount|0.00', 'the dealer can be taken off again');
-- staff who can edit invoices set it (it is not the owner's alone, unlike the bonus)
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_document');
SELECT pg_temp.dealer('a', '{"dealer_name": "ABC Computers", "dealer_commission_type": "percent", "dealer_commission_value": 2.5}');
SELECT pg_temp.eq(format('%s|%s', (pg_temp.inv('a')).dealer_name, (pg_temp.inv('a')).dealer_commission_value), 'ABC Computers|2.50',
                  'staff with Invoices → edit record the dealer and the commission');
SELECT pg_temp.login(current_setting('t.viewer')::uuid);
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_name": "Someone"}')$$, current_setting('t.a')), '42501',
                      'staff who can only view invoices can''t');
-- a quotation doesn't take a dealer (the invoice made from it does)
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.req('', '');
SELECT set_config('t.q', pg_temp.draft('Quote Co', NULL, '{"doc_type":"quotation","dealer_name":"Quote Dealer","dealer_commission_value":100}')::text, false);
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('q')).doc_type, (pg_temp.inv('q')).dealer_name, (pg_temp.inv('q')).dealer_commission_value),
                  'quotation||0.00', 'a quotation ignores the dealer fields');
-- issue A (credit, unpaid): staff can still change the dealer on it
SELECT public.admin_issue_invoice(current_setting('t.a')::int);
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_document');
SELECT pg_temp.dealer('a', '{"dealer_name": "ABC Computers", "dealer_commission_type": "percent", "dealer_commission_value": 2.5}');
SELECT pg_temp.ok((pg_temp.inv('a')).status = 'issued' AND (pg_temp.inv('a')).payment_status = 'unpaid', 'an issued, unpaid invoice keeps its dealer editable for staff');
-- B: a cash sale (paid at once) by staff — paid = final for staff (53), so only the owner adds the dealer
SELECT set_config('t.b', pg_temp.draft('Dealer Client B', '{"sale_type":"cash"}')::text, false);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_issue_invoice');
SELECT public.admin_issue_invoice(current_setting('t.b')::int);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_document');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_name": "abc computers ", "dealer_commission_type": "amount", "dealer_commission_value": 3000}')$$, current_setting('t.b')),
                      '22023', 'staff can''t add a dealer to a paid invoice', 'invoice_locked:%');
SELECT pg_temp.req('', '');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.dealer('b', '{"dealer_name": "abc computers ", "dealer_commission_type": "amount", "dealer_commission_value": 3000}');
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('b')).payment_status, (pg_temp.inv('b')).dealer_name, (pg_temp.inv('b')).dealer_commission_value),
                  'paid|abc computers|3000.00', 'the owner can (another spelling of the same dealer)');
-- C: a referral without commission; D: a draft (not counted); E: void (not counted, and frozen)
SELECT set_config('t.c', pg_temp.draft('Dealer Client C', '{"sale_type":"cash"}', '{"doc_type":"invoice","dealer_name":"Lanka Tech"}')::text, false);
SELECT public.admin_issue_invoice(current_setting('t.c')::int);
SELECT pg_temp.eq(format('%s|%s', (pg_temp.inv('c')).dealer_name, (pg_temp.inv('c')).dealer_commission_value), 'Lanka Tech|0.00',
                  'a dealer can be named without a commission');
SELECT set_config('t.d', pg_temp.draft('Draft Client', '{"sale_type":"cash"}', '{"doc_type":"invoice","dealer_name":"ABC Computers","dealer_commission_value":999}')::text, false);
SELECT set_config('t.e', pg_temp.draft('Void Client', '{"sale_type":"credit","credit_days":7}', '{"doc_type":"invoice","dealer_name":"ABC Computers","dealer_commission_value":777}')::text, false);
SELECT public.admin_issue_invoice(current_setting('t.e')::int);
SELECT public.admin_void_invoice(current_setting('t.e')::int, 'Customer cancelled');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"dealer_commission_value": 1}')$$, current_setting('t.e')), '22023',
                      'a void invoice''s dealer can''t change', 'invoice_void:%');
-- W: a website sale with a dealer counts too
SELECT set_config('t.w', pg_temp.draft('Web Buyer', '{"sale_type":"cash"}', '{"doc_type":"invoice","dealer_name":"Lanka Tech","dealer_commission_value":1000}')::text, false);
SELECT public.admin_issue_invoice(current_setting('t.w')::int);
SELECT pg_temp.logout();
ALTER TABLE public.invoices DISABLE TRIGGER invoices_05_channel;
UPDATE public.invoices SET channel = 'website' WHERE id = current_setting('t.w')::int;
ALTER TABLE public.invoices ENABLE TRIGGER invoices_05_channel;
SELECT pg_temp.throws($$UPDATE public.invoices SET dealer_commission_type = 'percent', dealer_commission_value = 101 WHERE id = current_setting('t.c')::int$$, '23514',
                      'the table itself refuses a % above 100');
SELECT pg_temp.throws($$UPDATE public.invoices SET dealer_name = NULL WHERE id = current_setting('t.w')::int$$, '23514',
                      'and a commission with no dealer');

-- ── 2. the names suggested on the invoice screen ───────────────────────────
SELECT pg_temp.login(current_setting('t.viewer')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_dealer_names');
SELECT pg_temp.eq((SELECT string_agg(n #>> '{}', ', ' ORDER BY ord) FROM jsonb_array_elements(public.admin_dealer_names()) WITH ORDINALITY AS x(n, ord)),
                  'Lanka Tech, ABC Computers', 'staff with Invoices → view get each dealer once (case and spaces ignored), the latest first, in its latest spelling');
SELECT pg_temp.req('', '');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.admin_dealer_names()$$, '42501', 'shoppers don''t');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_dealer_names()$$, '42501', 'nor does a signed-in customer');

-- ── 3. the dealers in the commission report (owner only) ────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.rep', public.admin_staff_commission_report(pg_temp.today() - 1, pg_temp.today() + 1)::text, false);
SELECT set_config('t.rep2', public.admin_staff_commission_report(pg_temp.today() + 10, pg_temp.today() + 20)::text, false);
SELECT pg_temp.logout();
CREATE FUNCTION pg_temp.rep() RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.rep')::jsonb $$;
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s', d ->> 'name', d ->> 'invoices', d ->> 'sales', d ->> 'commission'), ' | ' ORDER BY ord)
                     FROM jsonb_array_elements(pg_temp.rep() -> 'dealers') WITH ORDINALITY AS x(d, ord)),
                  'abc computers:2:380000.00:7750.00 | Lanka Tech:2:380000.00:1000.00',
                  'per dealer: A (2.5% of 190,000 = 4,750) + B (Rs. 3,000) under one name; Lanka Tech: C (no commission) + the website sale W (Rs. 1,000); no draft, no void');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s', i ->> 'dealer', i ->> 'commission_type', i ->> 'commission_value', i ->> 'commission'), ' | ' ORDER BY ord)
                     FROM jsonb_array_elements(pg_temp.rep() -> 'dealer_invoices') WITH ORDINALITY AS x(i, ord)),
                  'ABC Computers:percent:2.50:4750.00 | abc computers:amount:3000.00:3000.00 | Lanka Tech:amount:0.00:0.00 | Lanka Tech:amount:1000.00:1000.00',
                  'per invoice, with how the commission was set');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.rep() #>> '{dealer_totals,invoices}', pg_temp.rep() #>> '{dealer_totals,sales}', pg_temp.rep() #>> '{dealer_totals,commission}'),
                  '4|760000.00|8750.00', 'dealer totals');
SELECT pg_temp.ok(jsonb_typeof(pg_temp.rep() -> 'rows') = 'array' AND pg_temp.rep() ? 'totals', 'the staff part is still there (53''s test checks its figures)');
SELECT pg_temp.eq(format('%s|%s', jsonb_array_length(current_setting('t.rep2')::jsonb -> 'dealers'), current_setting('t.rep2')::jsonb #>> '{dealer_totals,commission}'), '0|0',
                  'another period has none');
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_staff_commission_report');
SELECT pg_temp.throws($$SELECT public.admin_staff_commission_report(current_date, current_date)$$, '42501', 'staff can''t see the report', 'not_authorised:%');
SELECT pg_temp.req('', '');

-- ── 4. delivery notes ───────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT format('%s|%s', delivery_note_prefix, delivery_note_next_number) FROM public.invoice_settings WHERE id), 'DN-|1',
                  'numbering starts at DN-0001');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s)$$, current_setting('t.d')), '22023',
                      'a draft has no delivery note yet', 'delivery_note_needs_issue:Issue the invoice first%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s)$$, current_setting('t.q')), '22023',
                      'a quotation has none', 'invoice_not_found:%');
SELECT pg_temp.throws($$SELECT public.admin_save_delivery_note(2000000000)$$, '22023', 'nor does a missing invoice', 'invoice_not_found:%');
SELECT set_config('t.dn', public.admin_save_delivery_note(current_setting('t.a')::int)::text, false);
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s|%s', current_setting('t.dn')::jsonb ->> 'number', current_setting('t.dn')::jsonb ->> 'created',
                         (pg_temp.dn('a')).delivered_on = pg_temp.today(), (pg_temp.dn('a')).recipient_name, (pg_temp.dn('a')).recipient_phone,
                         (pg_temp.dn('a')).created_by = current_setting('t.owner')::uuid),
                  'DN-0001|true|t|Dealer Client A|077 111 2222|t', 'the first one is DN-0001, dated today, for the invoice''s client and number');
SELECT pg_temp.eq((pg_temp.dn('a')).delivery_address, E'No. 5, Flower Road\nKollupitiya\nColombo 00300', 'the address comes from the invoice (with city and postal code)');
SELECT pg_temp.eq((SELECT delivery_note_next_number FROM public.invoice_settings WHERE id), 2, 'the counter moved on');
SELECT set_config('t.dn', public.admin_save_delivery_note(current_setting('t.a')::int,
                    '{"delivered_on": "2026-11-20", "recipient_name": "Nimal (security desk)", "recipient_phone": null, "delivery_address": "Unit 4, Galle Road\nColombo 03", "note": "Left at the security desk."}')::text, false);
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s|%s', current_setting('t.dn')::jsonb ->> 'number', current_setting('t.dn')::jsonb ->> 'created',
                         (pg_temp.dn('a')).delivered_on, (pg_temp.dn('a')).recipient_name, (pg_temp.dn('a')).recipient_phone, (pg_temp.dn('a')).note),
                  'DN-0001|false|2026-11-20|Nimal (security desk)||Left at the security desk.', 'saving again updates the same delivery note (one per invoice)');
SELECT pg_temp.eq((SELECT count(*) FROM public.delivery_notes WHERE invoice_id = current_setting('t.a')::int), 1::bigint, 'still one');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s, '{"signed_by": "x"}')$$, current_setting('t.a')), '22023',
                      'an unknown field is refused', 'invalid_delivery_note:The field “signed_by”%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s, '{"recipient_name": "  "}')$$, current_setting('t.a')), '22023',
                      'it says who it is delivered to', 'invalid_delivery_note:Say who it is delivered to.');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s, '{"delivered_on": "tomorrow"}')$$, current_setting('t.a')), '22023',
                      'the date is a date', 'invalid_delivery_note:The delivery date must be a date%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s, '{"delivered_on": null}')$$, current_setting('t.a')), '22023',
                      'and is required', 'invalid_delivery_note:The delivery date is required.');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s, jsonb_build_object('note', repeat('n', 1001)))$$, current_setting('t.a')), '22023',
                      'the note is at most 1,000 characters', 'invalid_delivery_note:The note can be at most 1,000 characters.');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s, '[]')$$, current_setting('t.a')), '22023',
                      'the details are an object', 'invalid_delivery_note:%');
-- the prefix and next number come from the invoice settings; a number in use is skipped
SELECT pg_temp.logout();
UPDATE public.invoice_settings SET delivery_note_prefix = 'DN/', delivery_note_next_number = 7 WHERE id;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.admin_save_delivery_note(current_setting('t.b')::int) ->> 'number', 'DN/0007', 'the prefix and next number follow the settings');
SELECT pg_temp.logout();
UPDATE public.invoice_settings SET delivery_note_next_number = 7 WHERE id;
SELECT pg_temp.throws($$UPDATE public.invoice_settings SET delivery_note_prefix = 'D N' WHERE id$$, '23514', 'a prefix has no spaces');
-- staff with Invoices → edit make one for a PAID invoice: the delivery note doesn't change the invoice
SELECT set_config('t.c_before', (SELECT to_jsonb(i) FROM public.invoices i WHERE id = current_setting('t.c')::int)::text, false);
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_delivery_note');
SELECT pg_temp.eq(public.admin_save_delivery_note(current_setting('t.c')::int, '{"note": "Delivered by Kasun."}') ->> 'number', 'DN/0008',
                  'staff make it for a paid invoice (DN/0007 is taken, so DN/0008)');
SELECT pg_temp.eq(format('%s|%s', (pg_temp.dn('c')).created_by = current_setting('t.clerk')::uuid, (pg_temp.inv('c')).payment_status), 't|paid',
                  'recorded as theirs; the invoice stays paid');
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT to_jsonb(i) FROM public.invoices i WHERE id = current_setting('t.c')::int), current_setting('t.c_before')::jsonb,
                  'the paid invoice itself is untouched');
-- who can read them
SELECT pg_temp.login(current_setting('t.viewer')::uuid);
SELECT pg_temp.req('GET', '/rest/v1/delivery_notes');
SELECT pg_temp.eq((SELECT count(*) FROM public.delivery_notes), 3::bigint, 'staff with Invoices → view read them');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_delivery_note');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s)$$, current_setting('t.w')), '42501',
                      'but can''t make one', 'not_authorised:Your account can''t make delivery notes.');
SELECT pg_temp.req('', '');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.delivery_notes), 0::bigint, 'a signed-in customer sees none');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s)$$, current_setting('t.w')), '42501', 'or makes one');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT count(*) FROM public.delivery_notes$$, '42501', 'shoppers can''t read the table at all');
SELECT pg_temp.throws($$INSERT INTO public.delivery_notes (invoice_id, number, recipient_name) VALUES (1, 'X', 'Y')$$, '42501', 'or write it');
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('PATCH', '/rest/v1/delivery_notes');
SELECT pg_temp.throws($$UPDATE public.delivery_notes SET note = 'x'$$, '42501', 'staff write only through the function');
-- a void invoice's delivery note stays on record but can't change
SELECT pg_temp.req('', '');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.f', pg_temp.draft('Void Later', '{"sale_type":"credit","credit_days":7}')::text, false);
SELECT public.admin_issue_invoice(current_setting('t.f')::int);
SELECT public.admin_save_delivery_note(current_setting('t.f')::int);
SELECT public.admin_void_invoice(current_setting('t.f')::int, 'Wrong client');
SELECT pg_temp.throws(format($$SELECT public.admin_save_delivery_note(%s, '{"note": "x"}')$$, current_setting('t.f')), '22023',
                      'a void invoice''s delivery note can''t change', 'invoice_void:%');
SELECT pg_temp.ok((pg_temp.dn('f')).number IS NOT NULL, 'it stays on record');
-- deleting: the owner only
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_delete_delivery_note');
SELECT pg_temp.throws(format($$SELECT public.admin_delete_delivery_note(%s)$$, current_setting('t.c')), '42501',
                      'staff never delete a delivery note', 'not_authorised:Only the owner can delete a delivery note.');
SELECT pg_temp.req('', '');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.admin_delete_delivery_note(current_setting('t.c')::int) ->> 'number', 'DN/0008', 'the owner deletes one made by mistake');
SELECT pg_temp.throws(format($$SELECT public.admin_delete_delivery_note(%s)$$, current_setting('t.c')), '22023', 'once', 'delivery_note_not_found:%');
SELECT pg_temp.eq(public.admin_save_delivery_note(current_setting('t.c')::int) ->> 'number', 'DN/0010', 'a new one takes the next number (F took DN/0009; DN/0008 isn''t reused)');
SELECT pg_temp.logout();

-- ── 5. re-run ───────────────────────────────────────────────────────────────
\ir ../migrations/57_dealer_commission_delivery_notes.sql
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('a')).dealer_name, (pg_temp.inv('a')).dealer_commission_value, (pg_temp.dn('a')).number),
                  'ABC Computers|2.50|DN-0001', 'a re-run keeps dealers and delivery notes');
SELECT pg_temp.eq((SELECT format('%s|%s', delivery_note_prefix, delivery_note_next_number) FROM public.invoice_settings WHERE id), 'DN/|11',
                  'and the numbering');
SELECT pg_temp.eq((SELECT count(*) FROM public.staff_api_map WHERE migration = '57'), 3::bigint, 'and three staff map rows');
