-- ═════════════════════════════════════════════════════════════════════════════
-- 28_invoice_sale_types.sql — Dock One Solutions
--
-- PURPOSE      How a sale is paid, chosen on the invoice itself (admin → Commerce → Invoices):
--                CASH    paid in full in cash at the sale
--                CARD    paid in full by card at the sale
--                CREDIT  the client pays part now (any amount, 0 allowed — cash, card, transfer…)
--                        and the balance within N days: the due date is the invoice date + N days
--              Issuing records what was paid at the sale as a payment (source = 'sale'), so the
--              balance, "paid / partially paid" and the printed invoice are right with no extra
--              step. The balance of a credit sale is paid later with "Record payment" (26).
--              When a balance falls due, the admin is told: admin_invoice_due_alerts() feeds the
--              alert bar on every admin page and the "Due" filter of the invoice list.
--
--   invoices           + sale_type (cash | card | credit, or NULL), upfront_amount, upfront_method,
--                        credit_days. Drafts change freely; once issued only credit_days may change
--                        (giving the client more time moves the due date). NULL = "not chosen": the
--                        invoice behaves exactly as before this file (no payment recorded at issue,
--                        its own due date) — every invoice written before 28, and any saved by an
--                        older admin build. The editor always sets one (new invoices start as Cash).
--   invoice_payments   + source: 'manual' (Record payment) | 'sale' (recorded when issued).
--   triggers           _invoice_sale_terms (BEFORE): due date = invoice date + credit days for a
--                        credit sale; cash / card carry no credit terms; checks a credit sale is
--                        complete when it is issued. _invoice_sale_payment (AFTER draft → issued):
--                        records the payment taken at the sale.
--   admin_save_invoice_sale(p_invoice, p_items, p_sale)   26's admin_save_invoice + the sale terms
--                        in ONE transaction (what the editor calls).
--   admin_revert_invoice   (replaces 26's) back to draft also removes the payment recorded at the
--                        sale; payments recorded afterwards still have to be deleted first.
--   admin_invoice_due_alerts(p_days_ahead)   issued invoices with a balance whose due date has
--                        come (overdue, due today) or comes within p_days_ahead days.
--
-- DEPENDS ON   26_invoices (tables, _invoice_recalc, _invoice_json, admin_save_invoice, the
--              stock / serial helpers), 23 (_admin_json_*), 02 (is_admin, customers).
-- RE-RUN ORDER Re-running 26 puts back 26's admin_revert_invoice (which refuses to revert an
--              invoice that has ANY payment) — run 28 again after 26.
-- ERRORS       as 26 (22023 `code:human text`): invalid_invoice, invoice_not_found,
--              invoice_locked, invoice_void, invoice_incomplete, invoice_has_payments.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columns
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS sale_type      TEXT;                               -- cash | card | credit | NULL (not chosen)
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS upfront_amount NUMERIC(14,2) NOT NULL DEFAULT 0;   -- credit: paid at the sale
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS upfront_method TEXT NOT NULL DEFAULT 'cash';       -- credit: how it was paid
  ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS credit_days    INT;                                -- credit: days to pay the balance

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_sale_type_valid') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_sale_type_valid CHECK (sale_type IS NULL OR sale_type IN ('cash', 'card', 'credit'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_sale_terms_valid') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_sale_terms_valid CHECK (
          upfront_amount >= 0 AND upfront_amount <= 1000000000000
      AND upfront_method IN ('cash', 'card', 'bank_transfer', 'cheque', 'online', 'other')
      AND (credit_days IS NULL OR credit_days BETWEEN 1 AND 365)
      AND (sale_type IS NOT DISTINCT FROM 'credit' OR (upfront_amount = 0 AND credit_days IS NULL)));
  END IF;
END $$;

ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_source_valid') THEN
    ALTER TABLE public.invoice_payments ADD CONSTRAINT invoice_payments_source_valid CHECK (source IN ('manual', 'sale'));
  END IF;
END $$;

COMMENT ON COLUMN public.invoices.sale_type IS 'cash | card = paid in full at the sale; credit = upfront_amount now, the balance within credit_days; NULL = not chosen (pre-28 behaviour).';
COMMENT ON COLUMN public.invoice_payments.source IS 'manual = Record payment; sale = recorded automatically when the invoice was issued.';

-- the alert query: issued, owing, by due date
CREATE INDEX IF NOT EXISTS invoices_due_alert_idx ON public.invoices (due_date, id) WHERE status = 'issued' AND balance_due > 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Triggers
-- ─────────────────────────────────────────────────────────────────────────────

-- BEFORE INSERT / UPDATE: keep the terms consistent, and refuse an incomplete credit sale at issue.
CREATE OR REPLACE FUNCTION public._invoice_sale_terms() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.sale_type IS NOT DISTINCT FROM 'credit' THEN
    IF NEW.credit_days IS NOT NULL THEN
      NEW.due_date := NEW.issue_date + NEW.credit_days;
    END IF;
  ELSE
    NEW.upfront_amount := 0;
    NEW.credit_days := NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- an issued sale keeps how it was paid (only the credit period may change)
    IF OLD.status = 'issued' AND NEW.status = 'issued'
       AND (NEW.sale_type IS DISTINCT FROM OLD.sale_type
            OR NEW.upfront_amount IS DISTINCT FROM OLD.upfront_amount
            OR NEW.upfront_method IS DISTINCT FROM OLD.upfront_method) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invoice_locked:%s is issued, so how it was paid is fixed. Move it back to draft to change it.', OLD.number);
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'issued' AND NEW.sale_type IS NOT DISTINCT FROM 'credit' THEN
      IF NEW.credit_days IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = 'invoice_incomplete:Enter how many days the client has to pay the balance before issuing.';
      END IF;
      IF NEW.total > 0 AND NEW.upfront_amount >= NEW.total THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = 'invalid_invoice:The amount paid now covers the whole invoice — choose Cash or Card instead of Credit.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._invoice_sale_terms() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_sale_terms ON public.invoices;
CREATE TRIGGER invoices_sale_terms BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._invoice_sale_terms();

-- AFTER draft → issued: what the client paid at the sale becomes a payment (source 'sale').
-- Not for an invoice without a sale type (pre-28 behaviour: payments are recorded by hand).
CREATE OR REPLACE FUNCTION public._invoice_sale_payment() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_today  DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_amount NUMERIC := CASE WHEN NEW.sale_type = 'credit' THEN NEW.upfront_amount ELSE NEW.total END;
  v_method TEXT := CASE NEW.sale_type WHEN 'cash' THEN 'cash' WHEN 'card' THEN 'card' ELSE NEW.upfront_method END;
BEGIN
  IF NEW.sale_type IS NULL THEN
    RETURN NULL;
  END IF;
  DELETE FROM public.invoice_payments WHERE invoice_id = NEW.id AND source = 'sale';
  IF v_amount > 0 THEN
    INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, note, source, created_by)
    VALUES (NEW.id, v_amount, LEAST(NEW.issue_date, v_today), v_method,
            CASE NEW.sale_type
              WHEN 'credit' THEN format('Paid at the sale — balance on credit, due %s', to_char(NEW.due_date, 'DD Mon YYYY'))
              ELSE 'Paid in full at the sale' END,
            'sale', (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()));
  END IF;
  PERFORM public._invoice_recalc(NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._invoice_sale_payment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_sale_payment ON public.invoices;
CREATE TRIGGER invoices_sale_payment AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'issued')
  EXECUTE FUNCTION public._invoice_sale_payment();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Save with the sale terms (the editor's one call)
-- ─────────────────────────────────────────────────────────────────────────────
-- p_sale: {sale_type, upfront_amount, upfront_method, credit_days} (all optional; omitted = keep).
-- Everything else is 26's admin_save_invoice, in the same transaction. Returns _invoice_json().
CREATE OR REPLACE FUNCTION public.admin_save_invoice_sale(p_invoice JSONB, p_items JSONB DEFAULT NULL, p_sale JSONB DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_keys    CONSTANT TEXT[] := ARRAY['sale_type', 'upfront_amount', 'upfront_method', 'credit_days'];
  c_i       CONSTANT TEXT := 'invalid_invoice';
  v_saved   JSONB;
  v_id      INT;
  inv       public.invoices;
  v_key     TEXT;
  v_type    TEXT;
  v_upfront NUMERIC;
  v_method  TEXT;
  v_days    INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can save invoices.';
  END IF;
  IF p_sale IS NOT NULL AND jsonb_typeof(p_sale) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The sale terms must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_sale, '{}'::jsonb)) LOOP
    IF NOT (v_key = ANY (c_keys)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_invoice:The field “%s” can''t be saved here.', left(v_key, 40));
    END IF;
  END LOOP;

  v_saved := public.admin_save_invoice(p_invoice, p_items);
  v_id := (v_saved -> 'invoice' ->> 'id')::INT;
  IF p_sale IS NULL OR p_sale = '{}'::jsonb THEN
    RETURN v_saved;
  END IF;

  SELECT * INTO inv FROM public.invoices WHERE id = v_id FOR UPDATE;
  v_type := CASE WHEN p_sale ? 'sale_type' THEN lower(btrim(COALESCE(p_sale ->> 'sale_type', ''))) ELSE inv.sale_type END;
  IF v_type IS NULL AND inv.sale_type IS NULL AND NOT (p_sale ? 'sale_type') THEN
    v_type := NULL;   -- not chosen and not being chosen: only credit_days etc. are meaningless then
  ELSIF v_type IS NULL OR v_type NOT IN ('cash', 'card', 'credit') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:Choose Cash, Card or Credit.';
  END IF;
  v_method := CASE WHEN p_sale ? 'upfront_method' THEN lower(btrim(COALESCE(p_sale ->> 'upfront_method', ''))) ELSE inv.upfront_method END;
  IF v_method NOT IN ('cash', 'card', 'bank_transfer', 'cheque', 'online', 'other') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:Choose how the amount paid now was paid.';
  END IF;
  v_upfront := CASE WHEN p_sale ? 'upfront_amount'
                    THEN COALESCE(public._admin_json_money(c_i, p_sale -> 'upfront_amount', 'The amount paid now'), 0)
                    ELSE inv.upfront_amount END;
  v_days := CASE WHEN p_sale ? 'credit_days'
                 THEN public._admin_json_int(c_i, p_sale -> 'credit_days', 'The number of credit days', 1, 365)
                 ELSE inv.credit_days END;
  IF v_type = 'credit' AND v_days IS NULL AND inv.status = 'issued' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:A credit sale needs the number of days the client has to pay (1–365).';
  END IF;
  IF v_type IS DISTINCT FROM 'credit' THEN
    v_upfront := 0;
    v_days := NULL;
  END IF;

  IF inv.status = 'void' THEN
    IF (v_type, v_upfront, v_method, v_days) IS DISTINCT FROM (inv.sale_type, inv.upfront_amount, inv.upfront_method, inv.credit_days) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void and can no longer be changed.', inv.number);
    END IF;
    RETURN v_saved;
  END IF;
  -- the invoice-level checks (locked fields, due date) are _invoice_sale_terms'
  UPDATE public.invoices
     SET sale_type = v_type, upfront_amount = v_upfront,
         upfront_method = CASE WHEN v_type IS NOT DISTINCT FROM 'credit' THEN v_method ELSE upfront_method END,
         credit_days = v_days
   WHERE id = v_id
     AND (sale_type, upfront_amount, upfront_method, credit_days)
         IS DISTINCT FROM (v_type, v_upfront, CASE WHEN v_type IS NOT DISTINCT FROM 'credit' THEN v_method ELSE upfront_method END, v_days);
  RETURN public._invoice_json(v_id) || jsonb_build_object('created', COALESCE((v_saved ->> 'created')::BOOLEAN, FALSE));
END $$;
REVOKE ALL ON FUNCTION public.admin_save_invoice_sale(JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_invoice_sale(JSONB, JSONB, JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Back to draft (replaces 26's): the payment recorded at the sale goes with the issue
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_revert_invoice(p_invoice_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv  public.invoices;
  v_np INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change invoices.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void and can no longer be changed.', inv.number);
  END IF;
  IF inv.status = 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_issued:This invoice is already a draft.';
  END IF;
  SELECT count(*)::INT INTO v_np FROM public.invoice_payments pay WHERE pay.invoice_id = inv.id AND pay.source = 'manual';
  IF v_np > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invoice_has_payments:%s has %s payment%s recorded. Delete %s first to move it back to draft.',
                       inv.number, v_np, CASE WHEN v_np = 1 THEN '' ELSE 's' END, CASE WHEN v_np = 1 THEN 'it' ELSE 'them' END);
  END IF;
  DELETE FROM public.invoice_payments WHERE invoice_id = inv.id AND source = 'sale';
  IF inv.stock_deducted THEN
    PERFORM public._invoice_return_stock(inv.id);
  END IF;
  PERFORM public._invoice_release_units(inv.id);
  UPDATE public.invoices SET status = 'draft' WHERE id = inv.id;
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_revert_invoice(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revert_invoice(INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Due alerts
-- ─────────────────────────────────────────────────────────────────────────────
-- Issued invoices that still owe money and whose due date is today or past, or within
-- p_days_ahead days (0–30). days = due date − today: < 0 overdue, 0 today, > 0 coming up.
CREATE OR REPLACE FUNCTION public.admin_invoice_due_alerts(p_days_ahead INT DEFAULT 3)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_ahead INT := LEAST(GREATEST(COALESCE(p_days_ahead, 3), 0), 30);
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can see payment alerts.';
  END IF;
  SELECT jsonb_build_object(
           'today',          v_today,
           'days_ahead',     v_ahead,
           'overdue_count',  count(*) FILTER (WHERE i.due_date < v_today),
           'overdue_total',  COALESCE(sum(i.balance_due) FILTER (WHERE i.due_date < v_today), 0),
           'due_today_count', count(*) FILTER (WHERE i.due_date = v_today),
           'due_today_total', COALESCE(sum(i.balance_due) FILTER (WHERE i.due_date = v_today), 0),
           'upcoming_count', count(*) FILTER (WHERE i.due_date > v_today),
           'items', COALESCE(jsonb_agg(jsonb_build_object(
                      'id', i.id, 'number', i.number, 'bill_to_name', i.bill_to_name, 'bill_to_phone', i.bill_to_phone,
                      'issue_date', i.issue_date, 'due_date', i.due_date, 'days', i.due_date - v_today,
                      'total', i.total, 'amount_paid', i.amount_paid, 'balance_due', i.balance_due, 'sale_type', i.sale_type)
                    ORDER BY i.due_date, i.id) FILTER (WHERE i.rn <= 100), '[]'::jsonb))
    INTO v_out
    FROM (SELECT x.*, row_number() OVER (ORDER BY x.due_date, x.id) AS rn
            FROM public.invoices x
           WHERE x.status = 'issued' AND x.balance_due > 0 AND x.due_date IS NOT NULL
             AND x.due_date <= v_today + v_ahead) i;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_invoice_due_alerts(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_invoice_due_alerts(INT) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 28_invoice_sale_types
--   Apply after 26. Nothing to configure: the editor starts new invoices as CASH; pick Card or
--   Credit there. A credit sale needs its credit days (1–365) before it can be issued. Invoices
--   written before 28 keep "not chosen" (NULL) and behave as they always did.
--   Verification:
--     SELECT sale_type, count(*) FROM public.invoices GROUP BY 1;
--     SELECT source, count(*) FROM public.invoice_payments GROUP BY 1;
--     SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
--       FROM pg_proc p WHERE p.proname IN ('admin_save_invoice_sale', 'admin_invoice_due_alerts');  -- false
--   What is owed and when (the admin alert bar shows the same):
--     SELECT number, bill_to_name, due_date, balance_due FROM public.invoices
--      WHERE status = 'issued' AND balance_due > 0 AND due_date <= (now() AT TIME ZONE 'Asia/Colombo')::date
--      ORDER BY due_date;
-- ═════════════════════════════════════════════════════════════════════════════
