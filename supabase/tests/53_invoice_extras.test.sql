-- 53_invoice_extras.test.sql — signature lines (the template's default, saving them), the bonus and
-- sales staff (owner only), paid invoices are final for staff (header and lines; the system's own
-- bookkeeping still works; unpaid ones stay editable; the owner can still change them), commission
-- (the % per staff member, the owner-only report and its arithmetic), the staff names list, re-run.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner53@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
UPDATE public.customers SET first_name = 'Anan', last_name = 'Owner' WHERE id = current_setting('t.owner')::uuid;
SELECT set_config('t.other', pg_temp.new_user('someone53@shop.test')::text, false);

INSERT INTO public.categories (id, name) VALUES ('qa53-cat', 'QA 53');
INSERT INTO public.products (slug, brand, name, category_id) VALUES
  ('qa53-laptop', 'QaBrand', 'Qa53 Laptop', 'qa53-cat'), ('qa53-mouse', 'QaBrand', 'Qa53 Mouse', 'qa53-cat');
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT p.id, v.sku, 'Standard', v.price FROM public.products p
  JOIN (VALUES ('qa53-laptop', 'Q53-LT', 200000), ('qa53-mouse', 'Q53-MS', 4000)) AS v(slug, sku, price) ON v.slug = p.slug;
INSERT INTO public.inventory (variant_id, stock_level) SELECT id, 20 FROM public.product_variants WHERE sku IN ('Q53-LT', 'Q53-MS');

CREATE FUNCTION pg_temp.vid(p_sku text) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.product_variants WHERE sku = p_sku $$;
CREATE FUNCTION pg_temp.inv(p_name text) RETURNS public.invoices LANGUAGE sql AS $$ SELECT * FROM public.invoices WHERE id = current_setting('t.' || p_name)::int $$;
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;
-- an invoice draft: a laptop (and a free mouse — a complimentary line at Rs. 0), discount Rs. 10,000
CREATE FUNCTION pg_temp.draft(p_client text, p_sale jsonb, p_doc jsonb DEFAULT '{"doc_type":"invoice"}') RETURNS int LANGUAGE sql AS $$
  SELECT (public.admin_save_document(jsonb_build_object('bill_to_name', p_client, 'bill_to_phone', '077 111 2222', 'discount_type', 'amount', 'discount_value', 10000),
            jsonb_build_array(jsonb_build_object('variant_id', pg_temp.vid('Q53-LT'), 'description', 'Qa53 Laptop', 'quantity', 1, 'unit_price', 200000),
                              jsonb_build_object('variant_id', pg_temp.vid('Q53-MS'), 'description', 'Qa53 Mouse', 'quantity', 1, 'unit_price', 0)),
            p_sale, p_doc) #>> '{invoice,id}')::int
$$;

-- ── 1. signature lines ──────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT default_show_signature_lines FROM public.invoice_settings WHERE id), FALSE, 'the template starts without signature lines');
SELECT pg_temp.eq((SELECT count(*) FILTER (WHERE show_signature_lines) FROM public.invoices), 0::bigint, 'no existing document gets them');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.d1', pg_temp.draft('Signature Co', '{"sale_type":"credit","credit_days":30}')::text, false);
SELECT pg_temp.eq((pg_temp.inv('d1')).show_signature_lines, FALSE, 'a new invoice follows the template (off)');
SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.d1')::int), NULL, NULL, '{"show_signature_lines": true}');
SELECT pg_temp.eq((pg_temp.inv('d1')).show_signature_lines, TRUE, 'the box on the invoice turns them on');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"show_signature_lines": "yes"}')$$, current_setting('t.d1')), '22023',
                      'it must be true or false', 'invalid_invoice:%');
SELECT pg_temp.logout();
UPDATE public.invoice_settings SET default_show_signature_lines = TRUE WHERE id;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.q1', pg_temp.draft('Quote Co', NULL, '{"doc_type":"quotation"}')::text, false);
SELECT pg_temp.eq((pg_temp.inv('q1')).show_signature_lines, TRUE, 'with the template''s default on, a new quotation prints them too');
SELECT pg_temp.logout();
UPDATE public.invoice_settings SET default_show_signature_lines = FALSE WHERE id;

-- ── 2. bonus and sales staff: the owner's ───────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.clerk', public.admin_create_staff('clerk53@shop.test', 'Counter2026', 'Kasun', '{"invoices": "edit", "receipts": "edit"}') ->> 'user_id', false);
SELECT set_config('t.viewer', public.admin_create_staff('view53@shop.test', 'Counter2026', 'Viewer', '{"invoices": "view"}') ->> 'user_id', false);
SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.d1')::int), NULL, NULL,
                                  jsonb_build_object('bonus', 2500, 'sales_staff_id', current_setting('t.clerk')));
SELECT pg_temp.eq(format('%s|%s', (pg_temp.inv('d1')).bonus, (pg_temp.inv('d1')).sales_staff_id = current_setting('t.clerk')::uuid), '2500.00|t',
                  'the owner sets a bonus and who the sale counts for');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"sales_staff_id": "%s"}')$$, current_setting('t.d1'), current_setting('t.other')),
                      '22023', 'only the owner or a staff account can be the sales staff', 'invalid_invoice:Choose the owner or a staff account%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"bonus": -5}')$$, current_setting('t.d1')), '22023',
                      'a negative bonus is refused', 'invalid_invoice:%');
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_document');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"bonus": 9999}')$$, current_setting('t.d1')), '42501',
                      'staff can''t set a bonus', 'not_authorised:Only the owner sets the bonus%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', NULL, NULL, '{"sales_staff_id": null}')$$, current_setting('t.d1')), '42501',
                      'or change who the sale counts for');
SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.d1')::int, 'bill_to_city', 'Kandy'), NULL, NULL,
                                  jsonb_build_object('bonus', 2500, 'show_signature_lines', FALSE));
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('d1')).bill_to_city, (pg_temp.inv('d1')).bonus, (pg_temp.inv('d1')).show_signature_lines), 'Kandy|2500.00|f',
                  'staff still save everything else (sending the unchanged bonus back is fine)');

-- ── 3. paid = final for staff ───────────────────────────────────────────────
SELECT set_config('t.paid', pg_temp.draft('Cash Buyer', '{"sale_type":"cash"}')::text, false);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_issue_invoice');
SELECT public.admin_issue_invoice(current_setting('t.paid')::int);
SELECT pg_temp.eq(format('%s|%s|%s', (pg_temp.inv('paid')).status, (pg_temp.inv('paid')).payment_status, (pg_temp.inv('paid')).total),
                  'issued|paid|190000.00', 'staff issued a cash sale: paid in full (the free mouse costs nothing)');
SELECT pg_temp.eq((SELECT stock_level FROM public.inventory WHERE variant_id = pg_temp.vid('Q53-MS')), 19, 'the complimentary mouse still left the stock');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_document');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s, "bill_to_phone": "077 999 0000"}', NULL, NULL, NULL)$$, current_setting('t.paid')), '22023',
                      'staff can''t change a paid invoice''s client details', 'invoice_locked:INV-% is paid, so it is final%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s}', (SELECT jsonb_agg(jsonb_build_object('id', id, 'description', description || ' (edited)', 'quantity', quantity, 'unit_price', unit_price, 'variant_id', variant_id) ORDER BY position) FROM public.invoice_items WHERE invoice_id = %s), NULL, NULL)$$,
                             current_setting('t.paid'), current_setting('t.paid')), '22023',
                      'or a line''s description', 'invoice_locked:%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id": %s, "internal_note": "x"}', NULL, NULL, NULL)$$, current_setting('t.paid')), '22023',
                      'or its internal note', 'invoice_locked:%');
SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.paid')::int), NULL, NULL, NULL);
SELECT pg_temp.ok(TRUE, 'saving it unchanged is harmless (the editor''s autosave)');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_mark_thank_you_sent');
SELECT public.admin_mark_thank_you_sent(current_setting('t.paid')::int);
SELECT pg_temp.ok((pg_temp.inv('paid')).thank_you_sent_at IS NOT NULL, 'the system''s own bookkeeping (the thank-you email flag) still works');
SELECT pg_temp.req('', '');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.paid')::int, 'bill_to_phone', '077 999 0000'), NULL, NULL, NULL);
SELECT pg_temp.eq((pg_temp.inv('paid')).bill_to_phone, '077 999 0000', 'the owner can still correct a paid invoice');
-- an issued invoice that is NOT paid stays editable for staff
SELECT public.admin_issue_invoice(current_setting('t.d1')::int);
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_document');
SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.d1')::int, 'bill_to_phone', '077 555 6666'), NULL, NULL, NULL);
SELECT pg_temp.eq((pg_temp.inv('d1')).bill_to_phone, '077 555 6666', 'an issued invoice on credit (unpaid) stays editable for staff');
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
UPDATE public.invoices SET bill_to_city = 'Galle' WHERE id = current_setting('t.paid')::int;
SELECT pg_temp.eq((pg_temp.inv('paid')).bill_to_city, 'Galle', 'the SQL editor (no signed-in user) is not blocked');

-- ── 4. commission ───────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.admin_set_staff_commission(current_setting('t.clerk')::uuid, 5) ->> 'commission_percent', '5.00', 'the owner sets Kasun''s commission to 5%');
SELECT pg_temp.throws(format($$SELECT public.admin_set_staff_commission('%s', 150)$$, current_setting('t.clerk')), '22023', 'a % above 100 is refused', 'invalid_staff:%');
SELECT pg_temp.eq((SELECT s ->> 'commission_percent' FROM jsonb_array_elements(public.admin_list_staff()) s WHERE s ->> 'user_id' = current_setting('t.clerk')), '5.00',
                  'the staff list shows it');
-- the owner's own invoice (paid) for comparison, and a website invoice that does not count
SELECT set_config('t.own', pg_temp.draft('Owner Sale', '{"sale_type":"cash"}')::text, false);
SELECT public.admin_issue_invoice(current_setting('t.own')::int);
SELECT pg_temp.logout();
-- (a website sale: 40's trigger would put an invoice with no web order back to 'store')
ALTER TABLE public.invoices DISABLE TRIGGER invoices_05_channel;
UPDATE public.invoices SET channel = 'website' WHERE id = current_setting('t.own')::int;
ALTER TABLE public.invoices ENABLE TRIGGER invoices_05_channel;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.rep', public.admin_staff_commission_report((now() AT TIME ZONE 'Asia/Colombo')::date - 1, (now() AT TIME ZONE 'Asia/Colombo')::date + 1)::text, false);
SELECT pg_temp.logout();
CREATE FUNCTION pg_temp.rep() RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.rep')::jsonb $$;
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s', r ->> 'name', r ->> 'invoices', r ->> 'sales', r ->> 'commission', r ->> 'bonus', r ->> 'total')
                     FROM jsonb_array_elements(pg_temp.rep() -> 'rows') r WHERE r ->> 'role' = 'staff'),
                  'Kasun|2|380000.00|19000.00|2500.00|21500.00',
                  'Kasun: 2 invoices (one he issued, one the owner credited to him), Rs 380,000 before VAT; 5% = 19,000 + bonus 2,500');
SELECT pg_temp.eq(jsonb_array_length(pg_temp.rep() -> 'rows'), 1, 'a website invoice with no sales staff named does not count');
SELECT pg_temp.eq(pg_temp.rep() #>> '{totals,total}', '21500.00', 'totals');
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_staff_commission_report');
SELECT pg_temp.throws($$SELECT public.admin_staff_commission_report(current_date, current_date)$$, '42501', 'staff can''t see commission', 'not_authorised:%');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_set_staff_commission');
SELECT pg_temp.throws(format($$SELECT public.admin_set_staff_commission('%s', 50)$$, current_setting('t.clerk')), '42501', 'or set their own %');

-- ── 5. the names list for the invoice screen ───────────────────────────────
SELECT pg_temp.login(current_setting('t.viewer')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_staff_names');
SELECT pg_temp.eq((SELECT string_agg(n ->> 'name', ', ' ORDER BY ord) FROM jsonb_array_elements(public.admin_staff_names()) WITH ORDINALITY AS x(n, ord)),
                  'Anan Owner, Kasun, Viewer', 'staff with Invoices → view get the names (owner first)');
SELECT pg_temp.req('', '');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.admin_staff_names()$$, '42501', 'shoppers don''t');
SELECT pg_temp.logout();

-- ── 6. re-run ───────────────────────────────────────────────────────────────
\ir ../migrations/53_invoice_extras.sql
SELECT pg_temp.eq(format('%s|%s', (pg_temp.inv('d1')).bonus, (SELECT commission_percent FROM public.staff_accounts WHERE user_id = current_setting('t.clerk')::uuid)),
                  '2500.00|5.00', 'a re-run keeps bonuses and commission rates');
SELECT pg_temp.eq((SELECT count(*) FROM public.staff_api_map WHERE migration = '53'), 3::bigint, 'and three staff map rows');
