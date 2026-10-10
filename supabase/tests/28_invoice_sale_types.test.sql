-- 28_invoice_sale_types.test.sql — cash / card / credit sales: the payment recorded when issued,
-- the credit due date (invoice date + days), the checks at issue, the issued lock (only the credit
-- period may change), back to draft (the sale payment goes, a later payment blocks), invoices with
-- no sale type behaving as before 28, the due alerts, and privileges.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('nimal@shop.test')::text, false);
SELECT set_config('t.today', ((now() AT TIME ZONE 'Asia/Colombo')::date)::text, false);

-- One free-text line of Rs. 50,000 (no stock involved); returns the new invoice id.
CREATE FUNCTION pg_temp.sale(p_name text, p_sale jsonb, p_issue_date date DEFAULT NULL) RETURNS int LANGUAGE sql AS $$
  SELECT (public.admin_save_invoice_sale(
            jsonb_strip_nulls(jsonb_build_object('bill_to_name', p_name, 'issue_date', p_issue_date)),
            jsonb_build_array(jsonb_build_object('description', 'Laptop setup and accessories', 'quantity', 1, 'unit_price', 50000)),
            p_sale) #>> '{invoice,id}')::int
$$;
CREATE FUNCTION pg_temp.inv(p_id int) RETURNS public.invoices LANGUAGE sql AS $$
  SELECT * FROM public.invoices WHERE id = p_id
$$;
CREATE FUNCTION pg_temp.pays(p_id int) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(format('%s:%s:%s', amount, method, source), ',' ORDER BY id), '-')
    FROM public.invoice_payments WHERE invoice_id = p_id
$$;

-- ── privileges ──────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.admin_save_invoice_sale('{}', NULL, '{}')$$, '42501', 'anon cannot execute admin_save_invoice_sale');
SELECT pg_temp.throws($$SELECT public.admin_invoice_due_alerts()$$, '42501', 'anon cannot read the due alerts');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_save_invoice_sale('{"bill_to_name":"x"}', NULL, '{"sale_type":"cash"}')$$, '42501',
                      'a shopper is refused by the in-body admin check', 'not_authorised:%');
SELECT pg_temp.throws($$SELECT public.admin_invoice_due_alerts()$$, '42501', 'a shopper cannot read the due alerts', 'not_authorised:%');

-- ── cash and card: paid in full when issued ─────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.cash', pg_temp.sale('Cash client', '{"sale_type":"cash"}')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', sale_type, total, balance_due, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.cash')::int)),
                  'cash|50000.00|50000.00|-', 'a cash draft owes the total and has no payment yet');
SELECT public.admin_issue_invoice(current_setting('t.cash')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', payment_status, amount_paid, balance_due, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.cash')::int)),
                  'paid|50000.00|0.00|50000.00:cash:sale', 'issuing a cash sale records the total in cash: paid');
SELECT pg_temp.eq((SELECT paid_on::text FROM public.invoice_payments WHERE invoice_id = current_setting('t.cash')::int),
                  current_setting('t.today'), 'the sale payment is dated the invoice date');

SELECT set_config('t.card', pg_temp.sale('Card client', '{"sale_type":"card"}')::text, false);
SELECT public.admin_issue_invoice(current_setting('t.card')::int);
SELECT pg_temp.eq((SELECT format('%s|%s', payment_status, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.card')::int)),
                  'paid|50000.00:card:sale', 'issuing a card sale records the total by card: paid');

-- cash / card never carry credit terms
SELECT set_config('t.mix', pg_temp.sale('Mixed', '{"sale_type":"cash","upfront_amount":1000,"credit_days":30}')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', sale_type, upfront_amount, COALESCE(credit_days::text, '∅')) FROM pg_temp.inv(current_setting('t.mix')::int)),
                  'cash|0.00|∅', 'credit terms sent with a cash sale are dropped');

-- ── credit: part now, the balance within N days ─────────────────────────────
SELECT set_config('t.cr', pg_temp.sale('Credit client',
  '{"sale_type":"credit","upfront_amount":10000,"upfront_method":"bank_transfer","credit_days":30}')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', sale_type, upfront_amount, due_date - issue_date) FROM pg_temp.inv(current_setting('t.cr')::int)),
                  'credit|10000.00|30', 'a credit draft: paid now and the due date = invoice date + 30 days');
SELECT public.admin_issue_invoice(current_setting('t.cr')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', payment_status, amount_paid, balance_due, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.cr')::int)),
                  'partial|10000.00|40000.00|10000.00:bank_transfer:sale', 'issuing records what was paid now; the balance stays owed');
SELECT pg_temp.ok((SELECT note FROM public.invoice_payments WHERE invoice_id = current_setting('t.cr')::int) LIKE 'Paid at the sale — balance on credit, due %',
                  'the sale payment says the balance is on credit');

-- nothing paid now
SELECT set_config('t.cr0', pg_temp.sale('Credit nothing now', '{"sale_type":"credit","upfront_amount":0,"credit_days":14}')::text, false);
SELECT public.admin_issue_invoice(current_setting('t.cr0')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', payment_status, balance_due, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.cr0')::int)),
                  'unpaid|50000.00|-', 'a credit sale with nothing paid now records no payment');

-- checks at issue (refused, and nothing changes)
SELECT set_config('t.crx', pg_temp.sale('Credit no days', '{"sale_type":"credit","upfront_amount":5000}')::text, false);
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.crx')), '22023',
                      'a credit sale without its days cannot be issued', 'invoice_incomplete:Enter how many days%');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', status, number IS NULL, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.crx')::int)),
                  'draft|t|-', 'the refused issue left the draft untouched (no number, no payment)');
SELECT public.admin_save_invoice_sale(jsonb_build_object('id', current_setting('t.crx')::int), NULL,
                                      '{"sale_type":"credit","upfront_amount":50000,"credit_days":7}');
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.crx')), '22023',
                      'paying the whole total now is not credit', 'invalid_invoice:The amount paid now covers the whole invoice%');
SELECT pg_temp.throws($$SELECT pg_temp.sale('Bad', '{"sale_type":"layaway"}')$$, '22023', 'an unknown sale type', 'invalid_invoice:Choose Cash, Card or Credit.');
SELECT pg_temp.throws($$SELECT pg_temp.sale('Bad', '{"sale_type":"credit","credit_days":400}')$$, '22023', 'more than 365 credit days', 'invalid_invoice:%');
SELECT pg_temp.throws($$SELECT pg_temp.sale('Bad', '{"sale_type":"credit","upfront_amount":-5,"credit_days":5}')$$, '22023', 'a negative amount paid now', 'invalid_invoice:%');
SELECT pg_temp.throws($$SELECT pg_temp.sale('Bad', '{"sale_type":"credit","upfront_method":"barter","credit_days":5}')$$, '22023', 'an unknown upfront method', 'invalid_invoice:%');
SELECT pg_temp.throws($$SELECT pg_temp.sale('Bad', '{"sale_type":"cash","surprise":1}')$$, '22023', 'an unknown sale field', 'invalid_invoice:The field “surprise”%');

-- ── the issued lock: only the credit period may change ──────────────────────
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice_sale('{"id":%s}', NULL, '{"sale_type":"cash"}')$$, current_setting('t.cr')),
                      '22023', 'an issued credit sale cannot become cash', 'invoice_locked:%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice_sale('{"id":%s}', NULL, '{"upfront_amount":20000}')$$, current_setting('t.cr')),
                      '22023', 'nor change what was paid at the sale', 'invoice_locked:%');
SELECT public.admin_save_invoice_sale(jsonb_build_object('id', current_setting('t.cr')::int), NULL, '{"credit_days":45}');
SELECT pg_temp.eq((SELECT format('%s|%s', credit_days, due_date - issue_date) FROM pg_temp.inv(current_setting('t.cr')::int)),
                  '45|45', 'giving the client more time moves the due date');
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.cr')::int, 'due_date', current_setting('t.today')));
SELECT pg_temp.eq((SELECT due_date - issue_date FROM pg_temp.inv(current_setting('t.cr')::int)), 45,
                  'a credit sale''s due date always follows its days (a typed due date is replaced)');

-- ── back to draft ───────────────────────────────────────────────────────────
SELECT public.admin_revert_invoice(current_setting('t.cash')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', status, balance_due, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.cash')::int)),
                  'draft|50000.00|-', 'back to draft removes the payment recorded at the sale');
SELECT public.admin_issue_invoice(current_setting('t.cash')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', status, payment_status, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.cash')::int)),
                  'issued|paid|50000.00:cash:sale', 'issuing again records it again (once)');
SELECT public.admin_record_invoice_payment(current_setting('t.cr')::int, 5000, current_setting('t.today')::date, 'cash');
SELECT pg_temp.eq(pg_temp.pays(current_setting('t.cr')::int), '10000.00:bank_transfer:sale,5000.00:cash:manual',
                  'a later payment is a manual one');
SELECT pg_temp.throws(format('SELECT public.admin_revert_invoice(%s)', current_setting('t.cr')), '22023',
                      'a payment recorded after the sale blocks back to draft', 'invoice_has_payments:% has 1 payment recorded. Delete it first%');

-- ── no sale type: exactly as before 28 ──────────────────────────────────────
SELECT set_config('t.old', (public.admin_save_invoice('{"bill_to_name":"Legacy"}',
  '[{"description":"Old-style line","quantity":1,"unit_price":1000}]') #>> '{invoice,id}'), false);
SELECT public.admin_issue_invoice(current_setting('t.old')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', COALESCE(sale_type, '∅'), payment_status, pg_temp.pays(id)) FROM pg_temp.inv(current_setting('t.old')::int)),
                  '∅|unpaid|-', 'an invoice without a sale type records nothing when issued');
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice_sale('{"id":%s}', NULL, '{"sale_type":"cash"}')$$, current_setting('t.old')),
                      '22023', 'and keeps "not chosen" once issued', 'invoice_locked:%');

-- ── due alerts ──────────────────────────────────────────────────────────────
SELECT set_config('t.late', pg_temp.sale('Late payer', '{"sale_type":"credit","upfront_amount":0,"credit_days":30}',
                                         current_setting('t.today')::date - 40)::text, false);
SELECT public.admin_issue_invoice(current_setting('t.late')::int);
SELECT set_config('t.soon', pg_temp.sale('Soon payer', '{"sale_type":"credit","upfront_amount":0,"credit_days":2}')::text, false);
SELECT public.admin_issue_invoice(current_setting('t.soon')::int);
SELECT set_config('t.due0', pg_temp.sale('Pays today', '{"sale_type":"credit","upfront_amount":1000,"credit_days":5}',
                                         current_setting('t.today')::date - 5)::text, false);
SELECT public.admin_issue_invoice(current_setting('t.due0')::int);

SELECT set_config('t.alerts', public.admin_invoice_due_alerts(3)::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', a ->> 'overdue_count', a ->> 'overdue_total', a ->> 'due_today_count', a ->> 'upcoming_count')
                     FROM (SELECT current_setting('t.alerts')::jsonb AS a) x),
                  '1|50000.00|1|1', 'one overdue, one due today, one coming up within 3 days');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', e ->> 'bill_to_name', e ->> 'days', e ->> 'balance_due'), ', ' ORDER BY ord)
                     FROM jsonb_array_elements(current_setting('t.alerts')::jsonb -> 'items') WITH ORDINALITY AS t(e, ord)),
                  'Late payer:-10:50000.00, Pays today:0:49000.00, Soon payer:2:50000.00',
                  'items by due date: days < 0 overdue, 0 today, > 0 coming up — paid and not-yet-due ones are left out');
SELECT pg_temp.eq((SELECT (public.admin_invoice_due_alerts(0) ->> 'upcoming_count')::int), 0, 'days ahead 0 = only what is due now');
SELECT public.admin_record_invoice_payment(current_setting('t.late')::int, 50000, current_setting('t.today')::date, 'cash');
SELECT pg_temp.eq((SELECT (public.admin_invoice_due_alerts(3) ->> 'overdue_count')::int), 0, 'paying the balance clears the alert');
SELECT pg_temp.eq((SELECT (public.admin_invoice_due_alerts(999) ->> 'days_ahead')::int), 30, 'days ahead is capped at 30');
