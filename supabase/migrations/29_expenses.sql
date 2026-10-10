-- ═════════════════════════════════════════════════════════════════════════════
-- 29_expenses.sql — Dock One Solutions
--
-- PURPOSE      The business's own spending, entered by hand in the admin (Commerce → Expenses):
--   expense_categories  what the money went on (Rent, Salaries & wages, Delivery & courier …).
--                       Twelve common ones are added once, into an EMPTY table — rename, reorder,
--                       switch off or delete them in the admin. A category that has expenses can't be
--                       deleted (switch it off instead: it then stops being offered for new ones).
--   expenses            one row per payment: date (Sri Lanka day), category, what it was for, amount
--                       (LKR), how it was paid, who was paid, bill / receipt no. and a note.
--   admin_expense_summary(p_from, p_to)   totals for a date range: overall, per category and per
--                       payment method (the tab's figures, so they never depend on paging).
--              Admins only: RLS (is_admin()) for every verb; anon holds no privilege at all.
-- DEPENDS ON   01_foundation (touch_updated_at), 02_customers_and_auth (customers, is_admin()).
-- ENABLES      admin → Commerce → Expenses.
-- ERRORS       23505 expense_categories_name_key (a category with that name exists),
--              23503 expenses_category_id_fkey (deleting a category that has expenses),
--              23514 CHECK names below, 42501 not_authorised:… (admin_expense_summary).
-- SAFE TO RE-RUN: yes (the starter categories go only into an empty table).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,          -- off = kept for old expenses, not offered for new ones
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expense_categories_name_valid CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name))
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_name_key ON public.expense_categories (lower(name));

CREATE TABLE IF NOT EXISTS public.expenses (
  id              SERIAL PRIMARY KEY,
  spent_on        DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Colombo')::date),
  category_id     INT NOT NULL REFERENCES public.expense_categories (id) ON DELETE RESTRICT,
  description     TEXT NOT NULL,                       -- what it was for
  amount          NUMERIC(14,2) NOT NULL,              -- LKR
  payment_method  TEXT NOT NULL DEFAULT 'cash',
  paid_to         TEXT,                                -- supplier / landlord / person
  reference       TEXT,                                -- bill, invoice or receipt number
  notes           TEXT,
  created_by      UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expenses_amount_valid  CHECK (amount > 0 AND amount <= 1000000000000 AND amount = round(amount, 2)),
  CONSTRAINT expenses_method_valid  CHECK (payment_method IN ('cash', 'bank_transfer', 'card', 'cheque', 'online', 'other')),
  CONSTRAINT expenses_date_valid    CHECK (spent_on >= DATE '2000-01-01'),
  CONSTRAINT expenses_text_lengths  CHECK (
        char_length(btrim(description)) BETWEEN 1 AND 300
    AND (paid_to   IS NULL OR char_length(paid_to)   <= 200)
    AND (reference IS NULL OR char_length(reference) <= 120)
    AND (notes     IS NULL OR char_length(notes)     <= 2000))
);
CREATE INDEX IF NOT EXISTS expenses_spent_on_idx ON public.expenses (spent_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS expenses_category_idx ON public.expenses (category_id, spent_on DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Triggers: updated_at; created_by = the admin who added it
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS expense_categories_touch ON public.expense_categories;
CREATE TRIGGER expense_categories_touch BEFORE UPDATE ON public.expense_categories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS expenses_touch ON public.expenses;
CREATE TRIGGER expenses_touch BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public._expenses_created_by() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.created_by := (SELECT c.id FROM public.customers c WHERE c.id = auth.uid());
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._expenses_created_by() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS expenses_created_by ON public.expenses;
CREATE TRIGGER expenses_created_by BEFORE INSERT ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public._expenses_created_by();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS: admins only
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses           ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.expense_categories, public.expenses FROM anon;
REVOKE ALL ON SEQUENCE public.expense_categories_id_seq, public.expenses_id_seq FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.expense_categories, public.expenses FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_categories, public.expenses TO authenticated;
GRANT USAGE ON SEQUENCE public.expense_categories_id_seq, public.expenses_id_seq TO authenticated;

DROP POLICY IF EXISTS expense_categories_admin_all ON public.expense_categories;
CREATE POLICY expense_categories_admin_all ON public.expense_categories
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS expenses_admin_all ON public.expenses;
CREATE POLICY expenses_admin_all ON public.expenses
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Summary for a date range (inclusive, Sri Lanka days)
-- ─────────────────────────────────────────────────────────────────────────────
-- {from, to, total, count, by_category: [{id, name, total, count}] (largest first),
--  by_method: [{method, total, count}]}
CREATE OR REPLACE FUNCTION public.admin_expense_summary(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can see expense figures.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_range:Choose a start date on or before the end date.';
  END IF;
  WITH x AS (
    SELECT e.amount, e.payment_method, e.category_id
      FROM public.expenses e
     WHERE e.spent_on BETWEEN p_from AND p_to
  )
  SELECT jsonb_build_object(
           'from', p_from,
           'to', p_to,
           'total', (SELECT COALESCE(sum(amount), 0) FROM x),
           'count', (SELECT count(*) FROM x),
           'by_category', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'total', t.total, 'count', t.n) ORDER BY t.total DESC, c.name)
               FROM (SELECT category_id, sum(amount) AS total, count(*) AS n FROM x GROUP BY category_id) t
               JOIN public.expense_categories c ON c.id = t.category_id), '[]'::jsonb),
           'by_method', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('method', m.payment_method, 'total', m.total, 'count', m.n) ORDER BY m.total DESC)
               FROM (SELECT payment_method, sum(amount) AS total, count(*) AS n FROM x GROUP BY payment_method) m), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_expense_summary(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_expense_summary(DATE, DATE) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Starter categories (only into an empty table — never beside the owner's own)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.expense_categories) THEN
    INSERT INTO public.expense_categories (name, sort_order)
    SELECT name, ord * 10
      FROM unnest(ARRAY[
             'Rent', 'Salaries & wages', 'Stock purchases', 'Electricity & water', 'Internet & phone',
             'Delivery & courier', 'Marketing & advertising', 'Shop supplies', 'Repairs & maintenance',
             'Transport & fuel', 'Bank charges & fees', 'Other']) WITH ORDINALITY AS t(name, ord);
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 29_expenses
--   Nothing to configure. The twelve starter categories can be renamed, switched off or deleted in
--   admin → Expenses → Categories.
--   Verification:
--     SELECT name, is_active FROM public.expense_categories ORDER BY sort_order, name;
--     SELECT has_table_privilege('anon', 'public.expenses', 'SELECT');                            -- false
--     SELECT has_function_privilege('anon', 'public.admin_expense_summary(date,date)', 'EXECUTE'); -- false
--   This month's spending by category:
--     SELECT c.name, sum(e.amount) FROM public.expenses e JOIN public.expense_categories c ON c.id = e.category_id
--      WHERE e.spent_on >= date_trunc('month', now() AT TIME ZONE 'Asia/Colombo')::date GROUP BY 1 ORDER BY 2 DESC;
-- ═════════════════════════════════════════════════════════════════════════════
