-- ═════════════════════════════════════════════════════════════════════════════
-- 38_stock_movements.sql — Dock One Solutions
--
-- PURPOSE      A stock movement ledger and the two inventory reports the client asked for
--              (Inventory report requirements, 15 Oct 2026): the inventory value report and the
--              product-wise movement report, both at SELLING prices only.
--
--   stock_movements    one row per change of PHYSICAL stock of a tracked variant: effective
--                      date/time, movement type, stock in / stock out (both positive, in their own
--                      columns), the document it came from (web order / invoice) or a typed
--                      reference, a note and the admin who recorded it. Rows are never edited by
--                      hand — a mistake is corrected by a new movement (or the document's own
--                      reversal: cancel / back to draft / void), never by rewriting history.
--   movement types     opening          stock on hand when the ledger started (counted once)
--                      received         new stock in (supplier delivery)
--                      sale             units handed over against a sale
--                      sale_reversal    a posted sale undone (invoice back to draft / void, an
--                                       issued web order cancelled and restocked)
--                      customer_return  a customer's return, physically restocked
--                      supplier_return  units sent back to a supplier
--                      adjustment_in    any other addition (count correction, a stock edit)
--                      adjustment_out   any other removal (loss, damage, count correction)
--
--   PHYSICAL vs AVAILABLE. `inventory.stock_level` (05) is what can still be SOLD: a web order
--   takes its units out the moment it is placed (place_order, 09). Those units are RESERVED, not
--   gone — they stay on the shelf until the order is handed over. So:
--       on hand (physical) = inventory.stock_level + units reserved by open web orders
--   and the ledger records the HAND-OVER as the sale, never the reservation (no double deduction):
--     * place_order          → nothing in the ledger; order_items.stock_reserved remembers the units
--     * out for delivery / shipped / delivered (delivery), collected (pickup)
--                            → a `sale` for the reserved units (once per order)
--     * cancelled before hand-over → nothing (the reservation is released)
--     * cancelled after hand-over  → `sale_reversal` for the restocked units
--     * invoice issued (stock deducted) → `sale`; back to draft / void → `sale_reversal`
--     * admin → Inventory → Record movement → received / customer return / supplier return /
--                              adjustment (+/−), with a reference, note and effective date/time
--     * any other stock edit (Inventory tab, product editor) → `adjustment_in` / `adjustment_out`
--     * stock tracking switched off / on → an adjustment taking the balance to 0 / back
--   How: an AFTER trigger on `inventory` posts every stock_level change as an adjustment; the order,
--   invoice-line and order-item triggers below then "claim" those rows in the SAME transaction and
--   turn them into what they really were (or drop a pure reservation). No 05/09/26 function is
--   replaced, so re-running those files never breaks the ledger.
--
--   admin_record_stock_movement(...)          record a receipt, return or adjustment
--   admin_inventory_value_report(...)         report 1: on hand × current selling price, per variant
--   admin_stock_movement_report(...)          report 2: opening / in / out / closing per variant
--   admin_stock_movement_history(...)         report 2 detail: one variant's movements + running balance
--   admin_stock_report_options()              filter lists (categories, brands, variants)
--              Dates are Sri Lanka (Asia/Colombo) days: start date 00:00 inclusive to the day after
--              the end date 00:00 exclusive. A selling price of 0 is "Price missing": its value is
--              NULL and the row is left out of the value total (and counted separately).
--              Admins only: RLS (is_admin()) to read the ledger, no write privilege for any API
--              role, every function re-checks is_admin().
-- DEPENDS ON   02 (customers, is_admin), 04 (products, product_variants, categories),
--              05 (inventory), 07 (orders, order_items), 09 (order flow), 26 + 28 (invoices).
-- ENABLES      admin → Commerce → Reports → Inventory value / Stock movement;
--              admin → Catalogue → Inventory → Record movement.
-- ERRORS       42501 not_authorised:…; 22023 invalid_range / invalid_movement / invalid_quantity /
--              invalid_date / not_tracked / variant_not_found / insufficient_stock:…
-- SAFE TO RE-RUN: yes. The opening balances are posted ONCE (app_config 'stock_ledger_started').
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────────────
-- What each web-order line took from the sellable stock when it was placed (0 = the variant was
-- not tracked, nothing was reserved). Set by trigger only.
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS stock_reserved INT NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_stock_reserved_valid') THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_stock_reserved_valid
      CHECK (stock_reserved BETWEEN 0 AND 1000);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS order_items_reserved_idx ON public.order_items (variant_id) WHERE stock_reserved > 0;

CREATE TABLE IF NOT EXISTS public.stock_movements (
  id             BIGSERIAL PRIMARY KEY,
  variant_id     INT NOT NULL REFERENCES public.product_variants (id) ON DELETE CASCADE,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),      -- effective date/time
  movement_type  TEXT NOT NULL,
  qty_in         INT NOT NULL DEFAULT 0,                  -- stock in  (positive)
  qty_out        INT NOT NULL DEFAULT 0,                  -- stock out (positive)
  source_type    TEXT,                                    -- 'order' | 'invoice' | NULL (recorded in the admin)
  source_id      TEXT,                                    -- the order id (DO-10042) or the invoice id
  reference      TEXT,                                    -- typed by the admin: GRN, supplier invoice, return note …
  note           TEXT,
  recorded_by    UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  xact_id        BIGINT NOT NULL DEFAULT txid_current(),  -- the transaction that posted it
  claimable      BOOLEAN NOT NULL DEFAULT FALSE,          -- an automatic stock-edit row a document may still claim (same transaction only)
  CONSTRAINT stock_movements_type_valid CHECK (movement_type IN ('opening', 'received', 'sale', 'sale_reversal',
                                                                 'customer_return', 'supplier_return',
                                                                 'adjustment_in', 'adjustment_out')),
  CONSTRAINT stock_movements_qty_valid CHECK (
        qty_in BETWEEN 0 AND 2000000 AND qty_out BETWEEN 0 AND 2000000
    AND CASE WHEN movement_type IN ('opening', 'received', 'sale_reversal', 'customer_return', 'adjustment_in')
             THEN qty_in > 0 AND qty_out = 0
             ELSE qty_out > 0 AND qty_in = 0 END),
  CONSTRAINT stock_movements_source_valid CHECK (
        (source_type IS NULL AND source_id IS NULL)
     OR (source_type IN ('order', 'invoice') AND source_id IS NOT NULL AND char_length(source_id) <= 40)),
  CONSTRAINT stock_movements_text_lengths CHECK (
        (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 120)
    AND (note      IS NULL OR char_length(btrim(note))      BETWEEN 1 AND 500))
);
CREATE INDEX IF NOT EXISTS stock_movements_variant_idx ON public.stock_movements (variant_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS stock_movements_source_idx  ON public.stock_movements (source_type, source_id) WHERE source_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_claim_idx   ON public.stock_movements (xact_id, variant_id) WHERE claimable;

-- Admins read; nobody writes through the API (the triggers and RPCs below are the only writers).
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_movements FROM anon;
REVOKE ALL ON SEQUENCE public.stock_movements_id_seq FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.stock_movements FROM authenticated;
GRANT SELECT ON public.stock_movements TO authenticated;
DROP POLICY IF EXISTS stock_movements_admin_read ON public.stock_movements;
CREATE POLICY stock_movements_admin_read ON public.stock_movements
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Helpers (internal — never granted)
-- ─────────────────────────────────────────────────────────────────────────────
-- Has a web order been handed over? Delivery: out for delivery (with the courier), shipped or
-- delivered. Pickup: collected ("Ready for pickup" is still on the shelf).
CREATE OR REPLACE FUNCTION public._stock_issued_status(p_status TEXT, p_fulfillment TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(p_status IN ('shipped', 'delivered')
                  OR (p_status = 'out_for_delivery' AND p_fulfillment IS DISTINCT FROM 'pickup'), FALSE)
$$;
REVOKE ALL ON FUNCTION public._stock_issued_status(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Units of a variant reserved by web orders that are neither cancelled nor handed over yet.
CREATE OR REPLACE FUNCTION public._stock_reserved(p_variant_id INT)
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(sum(oi.stock_reserved), 0)::INT
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
   WHERE oi.variant_id = p_variant_id AND oi.stock_reserved > 0 AND o.status <> 'cancelled'
     AND NOT EXISTS (SELECT 1 FROM public.stock_movements m
                      WHERE m.source_type = 'order' AND m.source_id = o.id AND m.movement_type = 'sale')
$$;
REVOKE ALL ON FUNCTION public._stock_reserved(INT) FROM PUBLIC, anon, authenticated;

-- The ledger balance (physical stock) of a variant.
CREATE OR REPLACE FUNCTION public._stock_balance(p_variant_id INT)
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(sum(m.qty_in - m.qty_out), 0)::INT FROM public.stock_movements m WHERE m.variant_id = p_variant_id
$$;
REVOKE ALL ON FUNCTION public._stock_balance(INT) FROM PUBLIC, anon, authenticated;

-- The admin signed in (NULL for a shopper, a guest or the SQL editor).
CREATE OR REPLACE FUNCTION public._stock_actor()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id FROM public.customers c WHERE c.id = auth.uid() AND c.is_admin
$$;
REVOKE ALL ON FUNCTION public._stock_actor() FROM PUBLIC, anon, authenticated;

-- Turn up to p_qty units of THIS transaction's automatic stock-edit rows of a variant (direction
-- 'in' or 'out') into a document movement — or, with p_type NULL, drop them (a reservation or its
-- release is not a physical movement). Splits a row when a document claims only part of it (two
-- invoice lines of one variant share one inventory update). Returns the units claimed.
CREATE OR REPLACE FUNCTION public._stock_claim(p_variant_id INT, p_direction TEXT, p_qty INT,
                                               p_type TEXT, p_source_type TEXT, p_source_id TEXT)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r      RECORD;
  v_left INT := GREATEST(COALESCE(p_qty, 0), 0);
  v_qty  INT;
  v_take INT;
BEGIN
  IF v_left = 0 OR p_variant_id IS NULL THEN
    RETURN 0;
  END IF;
  FOR r IN
    SELECT m.*
      FROM public.stock_movements m
     WHERE m.claimable AND m.xact_id = txid_current() AND m.variant_id = p_variant_id
       AND m.movement_type = CASE p_direction WHEN 'in' THEN 'adjustment_in' ELSE 'adjustment_out' END
     ORDER BY m.id
       FOR UPDATE
  LOOP
    EXIT WHEN v_left = 0;
    v_qty  := r.qty_in + r.qty_out;
    v_take := LEAST(v_left, v_qty);
    IF v_take = v_qty THEN
      IF p_type IS NULL THEN
        DELETE FROM public.stock_movements WHERE id = r.id;
      ELSE
        UPDATE public.stock_movements
           SET movement_type = p_type, source_type = p_source_type, source_id = p_source_id,
               note = NULL, claimable = FALSE
         WHERE id = r.id;
      END IF;
    ELSE
      UPDATE public.stock_movements
         SET qty_in  = CASE WHEN qty_in  > 0 THEN qty_in  - v_take ELSE 0 END,
             qty_out = CASE WHEN qty_out > 0 THEN qty_out - v_take ELSE 0 END
       WHERE id = r.id;
      IF p_type IS NOT NULL THEN
        INSERT INTO public.stock_movements (variant_id, occurred_at, movement_type, qty_in, qty_out,
                                            source_type, source_id, recorded_by)
        VALUES (p_variant_id, r.occurred_at, p_type,
                CASE WHEN p_direction = 'in' THEN v_take ELSE 0 END,
                CASE WHEN p_direction = 'in' THEN 0 ELSE v_take END,
                p_source_type, p_source_id, r.recorded_by);
      END IF;
    END IF;
    v_left := v_left - v_take;
  END LOOP;
  RETURN GREATEST(COALESCE(p_qty, 0), 0) - v_left;
END $$;
REVOKE ALL ON FUNCTION public._stock_claim(INT, TEXT, INT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Start the ledger once: what web orders still hold, then the opening balances
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_started TIMESTAMPTZ := now();
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = 'stock_ledger_started') THEN
    RETURN;
  END IF;
  -- Lines of open web orders (not cancelled, not handed over) of tracked variants hold their units.
  UPDATE public.order_items oi
     SET stock_reserved = LEAST(oi.quantity, 1000)
    FROM public.orders o
   WHERE o.id = oi.order_id AND o.status <> 'cancelled'
     AND NOT public._stock_issued_status(o.status, o.fulfillment)
     AND oi.variant_id IS NOT NULL AND oi.stock_reserved = 0
     AND EXISTS (SELECT 1 FROM public.inventory i WHERE i.variant_id = oi.variant_id);
  -- On hand per tracked variant = sellable + reserved.
  INSERT INTO public.stock_movements (variant_id, occurred_at, movement_type, qty_in, note)
  SELECT i.variant_id, v_started, 'opening', i.stock_level + COALESCE(r.qty, 0),
         'Stock on hand when the movement ledger started'
    FROM public.inventory i
    LEFT JOIN (SELECT oi.variant_id, sum(oi.stock_reserved)::INT AS qty
                 FROM public.order_items oi
                 JOIN public.orders o ON o.id = oi.order_id
                WHERE oi.stock_reserved > 0 AND o.status <> 'cancelled'
                GROUP BY oi.variant_id) r ON r.variant_id = i.variant_id
   WHERE i.stock_level + COALESCE(r.qty, 0) > 0;
  INSERT INTO public.app_config (name, value) VALUES ('stock_ledger_started', v_started::text);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Triggers
-- ─────────────────────────────────────────────────────────────────────────────
-- 4a. Every stock_level change of a tracked variant. With an explicit movement in
--     app.stock_move (admin_record_stock_movement) it is posted as that movement; otherwise as a
--     claimable adjustment a document trigger may relabel later in the same transaction.
CREATE OR REPLACE FUNCTION public._stock_inventory_moved() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ctx     JSONB;
  v_variant INT;
  v_delta   INT;
  v_note    TEXT;
  v_type    TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_variant := OLD.variant_id;
    -- the variant itself is being deleted: its movements go with it
    IF NOT EXISTS (SELECT 1 FROM public.product_variants v WHERE v.id = v_variant) THEN
      RETURN NULL;
    END IF;
    v_delta := -public._stock_balance(v_variant);
    v_note  := 'Stock tracking switched off';
  ELSIF TG_OP = 'INSERT' THEN
    v_variant := NEW.variant_id;
    v_delta := NEW.stock_level + public._stock_reserved(v_variant) - public._stock_balance(v_variant);
    v_note  := 'Stock tracking switched on';
  ELSE
    v_variant := NEW.variant_id;
    v_delta := NEW.stock_level - OLD.stock_level;
    v_note  := 'Stock level edited';
  END IF;
  IF v_delta = 0 THEN
    RETURN NULL;
  END IF;

  v_ctx := NULLIF(current_setting('app.stock_move', true), '')::jsonb;
  IF TG_OP = 'UPDATE' AND v_ctx IS NOT NULL THEN
    v_type := v_ctx ->> 'type';
    INSERT INTO public.stock_movements (variant_id, occurred_at, movement_type, qty_in, qty_out,
                                        reference, note, recorded_by)
    VALUES (v_variant, COALESCE((v_ctx ->> 'at')::timestamptz, now()), v_type,
            GREATEST(v_delta, 0), GREATEST(-v_delta, 0),
            v_ctx ->> 'reference', v_ctx ->> 'note', public._stock_actor());
  ELSE
    INSERT INTO public.stock_movements (variant_id, movement_type, qty_in, qty_out, note, recorded_by, claimable)
    VALUES (v_variant, CASE WHEN v_delta > 0 THEN 'adjustment_in' ELSE 'adjustment_out' END,
            GREATEST(v_delta, 0), GREATEST(-v_delta, 0), v_note, public._stock_actor(), TG_OP = 'UPDATE');
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._stock_inventory_moved() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS inventory_90_stock_ledger ON public.inventory;
CREATE TRIGGER inventory_90_stock_ledger AFTER INSERT OR DELETE OR UPDATE OF stock_level ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION public._stock_inventory_moved();

-- 4b. A web-order line: place_order has just taken its units off the sellable stock (same
--     transaction). That is a reservation, not a movement — drop it and remember the units.
CREATE OR REPLACE FUNCTION public._stock_order_item_reserve() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.stock_reserved := CASE WHEN NEW.variant_id IS NULL THEN 0
                             ELSE LEAST(public._stock_claim(NEW.variant_id, 'out', NEW.quantity, NULL, NULL, NULL), 1000) END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._stock_order_item_reserve() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS order_items_90_stock_reserve ON public.order_items;
CREATE TRIGGER order_items_90_stock_reserve BEFORE INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._stock_order_item_reserve();

-- 4c. A web order's status: handed over → the sale; cancelled → reversal or released reservation.
--     (admin_set_order_status restocks BEFORE it updates the order, so the restock rows exist.)
CREATE OR REPLACE FUNCTION public._stock_order_status() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r        RECORD;
  v_issued BOOLEAN;
  v_old_handed BOOLEAN;
  v_sold   INT;
  v_back   INT;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  v_issued := EXISTS (SELECT 1 FROM public.stock_movements m
                       WHERE m.source_type = 'order' AND m.source_id = NEW.id AND m.movement_type = 'sale');

  IF NEW.status = 'cancelled' THEN
    -- handed over before the ledger started (nothing reserved, so no sale was posted)
    v_old_handed := NOT v_issued AND public._stock_issued_status(OLD.status, OLD.fulfillment)
                    AND NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id = NEW.id AND oi.stock_reserved > 0);
    FOR r IN
      SELECT oi.variant_id, sum(oi.quantity)::INT AS qty, sum(oi.stock_reserved)::INT AS reserved
        FROM public.order_items oi
       WHERE oi.order_id = NEW.id AND oi.variant_id IS NOT NULL
       GROUP BY oi.variant_id
    LOOP
      IF v_issued THEN
        SELECT COALESCE(sum(m.qty_out) FILTER (WHERE m.movement_type = 'sale'), 0)::INT,
               COALESCE(sum(m.qty_in)  FILTER (WHERE m.movement_type = 'sale_reversal'), 0)::INT
          INTO v_sold, v_back
          FROM public.stock_movements m
         WHERE m.source_type = 'order' AND m.source_id = NEW.id AND m.variant_id = r.variant_id;
        PERFORM public._stock_claim(r.variant_id, 'in', LEAST(r.qty, GREATEST(v_sold - v_back, 0)),
                                    'sale_reversal', 'order', NEW.id);
      ELSIF v_old_handed THEN
        PERFORM public._stock_claim(r.variant_id, 'in', r.qty, 'customer_return', 'order', NEW.id);
      ELSE
        PERFORM public._stock_claim(r.variant_id, 'in', r.reserved, NULL, NULL, NULL);
      END IF;
    END LOOP;
  ELSIF public._stock_issued_status(NEW.status, NEW.fulfillment) AND NOT v_issued THEN
    INSERT INTO public.stock_movements (variant_id, movement_type, qty_out, source_type, source_id, recorded_by)
    SELECT oi.variant_id, 'sale', sum(oi.stock_reserved)::INT, 'order', NEW.id, public._stock_actor()
      FROM public.order_items oi
     WHERE oi.order_id = NEW.id AND oi.variant_id IS NOT NULL AND oi.stock_reserved > 0
     GROUP BY oi.variant_id
     ORDER BY oi.variant_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._stock_order_status() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_90_stock_ledger ON public.orders;
CREATE TRIGGER orders_90_stock_ledger AFTER UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public._stock_order_status();

-- 4d. An invoice line taking stock (issue) or giving it back (back to draft / void). 26 updates
--     the inventory first and then the line's stock_taken, in the same transaction.
CREATE OR REPLACE FUNCTION public._stock_invoice_line() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.variant_id IS NULL OR NEW.stock_taken = OLD.stock_taken THEN
    RETURN NULL;
  END IF;
  IF NEW.stock_taken > OLD.stock_taken THEN
    PERFORM public._stock_claim(NEW.variant_id, 'out', NEW.stock_taken - OLD.stock_taken, 'sale', 'invoice', NEW.invoice_id::text);
  ELSE
    PERFORM public._stock_claim(NEW.variant_id, 'in', OLD.stock_taken - NEW.stock_taken, 'sale_reversal', 'invoice', NEW.invoice_id::text);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._stock_invoice_line() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoice_items_90_stock_ledger ON public.invoice_items;
CREATE TRIGGER invoice_items_90_stock_ledger AFTER UPDATE OF stock_taken ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._stock_invoice_line();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Record a movement (admin → Inventory → Record movement)
-- ─────────────────────────────────────────────────────────────────────────────
-- p_type: received | customer_return | supplier_return | adjustment_in | adjustment_out.
-- p_occurred_at: the effective date/time (default now) — not in the future, not before the ledger
-- started. Returns {movement_id, variant_id, type, quantity, stock_level, on_hand}.
CREATE OR REPLACE FUNCTION public.admin_record_stock_movement(
  p_variant_id  INT,
  p_type        TEXT,
  p_quantity    INT,
  p_reference   TEXT        DEFAULT NULL,
  p_note        TEXT        DEFAULT NULL,
  p_occurred_at TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_type    TEXT := lower(btrim(COALESCE(p_type, '')));
  v_ref     TEXT := NULLIF(btrim(COALESCE(p_reference, ''), E' \t\r\n'), '');
  v_note    TEXT := NULLIF(btrim(COALESCE(p_note, ''), E' \t\r\n'), '');
  v_at      TIMESTAMPTZ := COALESCE(p_occurred_at, now());
  v_in      BOOLEAN;
  v_stock   INT;
  v_label   TEXT;
  v_started TIMESTAMPTZ;
  v_new     INT;
  v_id      BIGINT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can record stock movements.';
  END IF;
  IF v_type NOT IN ('received', 'customer_return', 'supplier_return', 'adjustment_in', 'adjustment_out') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_movement:Choose what happened: stock received, customer return, supplier return or an adjustment.';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 1000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_quantity:The quantity must be a whole number from 1 to 1,000,000.';
  END IF;
  IF char_length(COALESCE(v_ref, '')) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_movement:The reference can be at most 120 characters.';
  END IF;
  IF char_length(COALESCE(v_note, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_movement:The note can be at most 500 characters.';
  END IF;
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_date:The date and time can''t be in the future.';
  END IF;
  SELECT value::timestamptz INTO v_started FROM public.app_config WHERE name = 'stock_ledger_started';
  IF v_started IS NOT NULL AND v_at < v_started THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invalid_date:Movements start on %s (Sri Lanka time), when the stock ledger began — the opening balance already counts everything before it.',
                       to_char(v_started AT TIME ZONE 'Asia/Colombo', 'DD Mon YYYY, HH24:MI'));
  END IF;

  SELECT i.stock_level, p.name || CASE WHEN p.variant_count > 1 THEN ' (' || v.name || ')' ELSE '' END
    INTO v_stock, v_label
    FROM public.inventory i
    JOIN public.product_variants v ON v.id = i.variant_id
    JOIN public.products p ON p.id = v.product_id
   WHERE i.variant_id = p_variant_id
     FOR UPDATE OF i;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.product_variants v WHERE v.id = p_variant_id) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'not_tracked:Switch on stock tracking for this variant first (Inventory → Track stock).';
    END IF;
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'variant_not_found:That product variant no longer exists.';
  END IF;

  v_in := v_type IN ('received', 'customer_return', 'adjustment_in');
  IF NOT v_in AND v_stock < p_quantity THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('insufficient_stock:Only %s of “%s” can be taken out — units held for web orders that haven''t been handed over yet stay in stock.',
                       v_stock, left(v_label, 120));
  END IF;
  IF v_in AND v_stock + p_quantity > 1000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_quantity:That would take the stock above 1,000,000.';
  END IF;

  PERFORM set_config('app.stock_move',
                     jsonb_build_object('type', v_type, 'reference', v_ref, 'note', v_note, 'at', v_at)::text, true);
  UPDATE public.inventory
     SET stock_level = stock_level + CASE WHEN v_in THEN p_quantity ELSE -p_quantity END
   WHERE variant_id = p_variant_id
  RETURNING stock_level INTO v_new;
  PERFORM set_config('app.stock_move', '', true);

  SELECT max(m.id) INTO v_id
    FROM public.stock_movements m
   WHERE m.variant_id = p_variant_id AND m.xact_id = txid_current() AND m.movement_type = v_type;
  RETURN jsonb_build_object('movement_id', v_id, 'variant_id', p_variant_id, 'type', v_type, 'quantity', p_quantity,
                            'stock_level', v_new, 'on_hand', v_new + public._stock_reserved(p_variant_id));
END $$;
REVOKE ALL ON FUNCTION public.admin_record_stock_movement(INT, TEXT, INT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_record_stock_movement(INT, TEXT, INT, TEXT, TEXT, TIMESTAMPTZ) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Reports
-- ─────────────────────────────────────────────────────────────────────────────
-- The variants a report covers, with the filters every report shares:
--   p_search    product / brand / variant / SKU text (any case)
--   p_category  category id; '__none__' = no category; NULL/'' = all
--   p_brand     brand (any case); NULL/'' = all
--   p_variant   one variant; NULL = all
CREATE OR REPLACE FUNCTION public._stock_report_variants(p_search TEXT, p_category TEXT, p_brand TEXT, p_variant INT)
RETURNS TABLE (variant_id INT, product_id INT, code TEXT, product_name TEXT, brand TEXT, variant_name TEXT,
               specs TEXT, category_id TEXT, category_name TEXT, price NUMERIC, tracked BOOLEAN, stock_level INT,
               sort_key TEXT, sort_position INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.id, p.id, COALESCE(v.sku, 'V' || v.id), p.name, p.brand,
         CASE WHEN p.variant_count > 1 OR lower(v.name) <> 'standard' THEN v.name END,
         NULLIF(btrim(COALESCE(p.subtitle, '')), ''), p.category_id, c.name, v.price,
         i.variant_id IS NOT NULL, i.stock_level,
         lower(COALESCE(c.name, '~') || '|' || p.brand || '|' || p.name), v.position
    FROM public.product_variants v
    JOIN public.products p ON p.id = v.product_id
    LEFT JOIN public.categories c ON c.id = p.category_id
    LEFT JOIN public.inventory i ON i.variant_id = v.id
   WHERE (p_variant IS NULL OR v.id = p_variant)
     AND (COALESCE(p_category, '') = ''
          OR (p_category = '__none__' AND p.category_id IS NULL)
          OR p.category_id = p_category)
     AND (COALESCE(btrim(p_brand), '') = '' OR lower(p.brand) = lower(btrim(p_brand)))
     AND (COALESCE(btrim(p_search), '') = ''
          OR strpos(lower(concat_ws(' ', p.brand, p.name, v.name, v.sku, p.subtitle)), lower(btrim(p_search))) > 0)
$$;
REVOKE ALL ON FUNCTION public._stock_report_variants(TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;

-- Reserved units per variant (open web orders not handed over).
CREATE OR REPLACE FUNCTION public._stock_reserved_all()
RETURNS TABLE (variant_id INT, qty INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT oi.variant_id, sum(oi.stock_reserved)::INT
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
   WHERE oi.stock_reserved > 0 AND oi.variant_id IS NOT NULL AND o.status <> 'cancelled'
     AND NOT EXISTS (SELECT 1 FROM public.stock_movements m
                      WHERE m.source_type = 'order' AND m.source_id = o.id AND m.movement_type = 'sale')
   GROUP BY oi.variant_id
$$;
REVOKE ALL ON FUNCTION public._stock_reserved_all() FROM PUBLIC, anon, authenticated;

-- 6a. Inventory value: one row per TRACKED variant, now.
--   quantity = physical stock on hand (sellable + reserved for web orders not yet handed over)
--   value    = quantity × current selling price; NULL when the price is missing (0)
-- {generated_at, rows: [...], totals: {rows, quantity, value, priced_rows, missing_price_rows,
--  missing_price_quantity, reserved}}
CREATE OR REPLACE FUNCTION public.admin_inventory_value_report(
  p_search     TEXT DEFAULT NULL,
  p_category   TEXT DEFAULT NULL,
  p_brand      TEXT DEFAULT NULL,
  p_variant_id INT  DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can see stock reports.';
  END IF;
  WITH x AS (
    SELECT f.*, COALESCE(r.qty, 0) AS reserved, f.stock_level + COALESCE(r.qty, 0) AS quantity,
           f.price <= 0 AS price_missing
      FROM public._stock_report_variants(p_search, p_category, p_brand, p_variant_id) f
      LEFT JOIN public._stock_reserved_all() r ON r.variant_id = f.variant_id
     WHERE f.tracked
  )
  SELECT jsonb_build_object(
           'generated_at', now(),
           'rows', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'variant_id', x.variant_id, 'product_id', x.product_id, 'code', x.code,
                      'product_name', x.product_name, 'brand', x.brand, 'variant_name', x.variant_name,
                      'specs', x.specs, 'category_id', x.category_id, 'category_name', x.category_name,
                      'quantity', x.quantity, 'reserved', x.reserved,
                      'price', CASE WHEN x.price_missing THEN NULL ELSE x.price END,
                      'price_missing', x.price_missing,
                      'value', CASE WHEN x.price_missing THEN NULL ELSE x.quantity * x.price END)
                    ORDER BY x.sort_key, x.sort_position, x.variant_id)
               FROM x), '[]'::jsonb),
           'totals', (SELECT jsonb_build_object(
                        'rows', count(*),
                        'quantity', COALESCE(sum(x.quantity), 0),
                        'reserved', COALESCE(sum(x.reserved), 0),
                        'value', COALESCE(sum(x.quantity * x.price) FILTER (WHERE NOT x.price_missing), 0),
                        'priced_rows', count(*) FILTER (WHERE NOT x.price_missing),
                        'missing_price_rows', count(*) FILTER (WHERE x.price_missing),
                        'missing_price_quantity', COALESCE(sum(x.quantity) FILTER (WHERE x.price_missing), 0))
                        FROM x))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_inventory_value_report(TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_inventory_value_report(TEXT, TEXT, TEXT, INT) TO authenticated;

-- 6b. Product-wise movement summary for a date range (Sri Lanka days, inclusive).
--   opening  = every movement before the start (+ the ledger's opening balance, counted once)
--   sales    = units sold in the period − sales reversed in the period
--   closing  = opening + received + customer returns − sales − supplier returns + adj. in − adj. out
--   closing_value = closing × CURRENT selling price (NULL when the price is missing)
-- Variants: tracked now, or with any movement before the end of the range.
-- {from, to, generated_at, ledger_started, rows: [...], totals: {...}}
CREATE OR REPLACE FUNCTION public.admin_stock_movement_report(
  p_from       DATE,
  p_to         DATE,
  p_search     TEXT DEFAULT NULL,
  p_category   TEXT DEFAULT NULL,
  p_brand      TEXT DEFAULT NULL,
  p_variant_id INT  DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_start TIMESTAMPTZ;
  v_end   TIMESTAMPTZ;
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can see stock reports.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_from < DATE '2000-01-01' OR p_to > DATE '2999-12-31' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_range:Choose a start date on or before the end date.';
  END IF;
  v_start := p_from::timestamp AT TIME ZONE 'Asia/Colombo';
  v_end   := (p_to + 1)::timestamp AT TIME ZONE 'Asia/Colombo';

  WITH f AS (
    SELECT * FROM public._stock_report_variants(p_search, p_category, p_brand, p_variant_id)
  ), m AS (
    SELECT s.variant_id,
           COALESCE(sum(s.qty_in - s.qty_out) FILTER (WHERE s.occurred_at < v_start OR s.movement_type = 'opening'), 0)::INT AS opening,
           COALESCE(sum(s.qty_in)  FILTER (WHERE s.occurred_at >= v_start AND s.movement_type = 'received'), 0)::INT        AS received,
           (COALESCE(sum(s.qty_out) FILTER (WHERE s.occurred_at >= v_start AND s.movement_type = 'sale'), 0)
            - COALESCE(sum(s.qty_in) FILTER (WHERE s.occurred_at >= v_start AND s.movement_type = 'sale_reversal'), 0))::INT AS sales,
           COALESCE(sum(s.qty_in)  FILTER (WHERE s.occurred_at >= v_start AND s.movement_type = 'customer_return'), 0)::INT AS customer_returns,
           COALESCE(sum(s.qty_out) FILTER (WHERE s.occurred_at >= v_start AND s.movement_type = 'supplier_return'), 0)::INT AS supplier_returns,
           COALESCE(sum(s.qty_in)  FILTER (WHERE s.occurred_at >= v_start AND s.movement_type = 'adjustment_in'), 0)::INT   AS adjustments_in,
           COALESCE(sum(s.qty_out) FILTER (WHERE s.occurred_at >= v_start AND s.movement_type = 'adjustment_out'), 0)::INT  AS adjustments_out
      FROM public.stock_movements s
     WHERE s.occurred_at < v_end AND s.variant_id IN (SELECT f.variant_id FROM f)
     GROUP BY s.variant_id
  ), x AS (
    SELECT f.*, COALESCE(m.opening, 0) AS opening, COALESCE(m.received, 0) AS received, COALESCE(m.sales, 0) AS sales,
           COALESCE(m.customer_returns, 0) AS customer_returns, COALESCE(m.supplier_returns, 0) AS supplier_returns,
           COALESCE(m.adjustments_in, 0) AS adjustments_in, COALESCE(m.adjustments_out, 0) AS adjustments_out,
           COALESCE(m.opening, 0) + COALESCE(m.received, 0) + COALESCE(m.customer_returns, 0) - COALESCE(m.sales, 0)
             - COALESCE(m.supplier_returns, 0) + COALESCE(m.adjustments_in, 0) - COALESCE(m.adjustments_out, 0) AS closing,
           f.price <= 0 AS price_missing
      FROM f
      LEFT JOIN m ON m.variant_id = f.variant_id
     WHERE f.tracked OR m.variant_id IS NOT NULL
  )
  SELECT jsonb_build_object(
           'from', p_from, 'to', p_to, 'generated_at', now(),
           'ledger_started', (SELECT value::timestamptz FROM public.app_config WHERE name = 'stock_ledger_started'),
           'rows', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'variant_id', x.variant_id, 'product_id', x.product_id, 'code', x.code,
                      'product_name', x.product_name, 'brand', x.brand, 'variant_name', x.variant_name,
                      'specs', x.specs, 'category_id', x.category_id, 'category_name', x.category_name,
                      'tracked', x.tracked,
                      'opening', x.opening, 'received', x.received, 'sales', x.sales,
                      'customer_returns', x.customer_returns, 'supplier_returns', x.supplier_returns,
                      'adjustments_in', x.adjustments_in, 'adjustments_out', x.adjustments_out,
                      'closing', x.closing,
                      'price', CASE WHEN x.price_missing THEN NULL ELSE x.price END,
                      'price_missing', x.price_missing,
                      'closing_value', CASE WHEN x.price_missing THEN NULL ELSE x.closing * x.price END)
                    ORDER BY x.sort_key, x.sort_position, x.variant_id)
               FROM x), '[]'::jsonb),
           'totals', (SELECT jsonb_build_object(
                        'rows', count(*),
                        'opening', COALESCE(sum(x.opening), 0),
                        'received', COALESCE(sum(x.received), 0),
                        'sales', COALESCE(sum(x.sales), 0),
                        'customer_returns', COALESCE(sum(x.customer_returns), 0),
                        'supplier_returns', COALESCE(sum(x.supplier_returns), 0),
                        'adjustments_in', COALESCE(sum(x.adjustments_in), 0),
                        'adjustments_out', COALESCE(sum(x.adjustments_out), 0),
                        'closing', COALESCE(sum(x.closing), 0),
                        'closing_value', COALESCE(sum(x.closing * x.price) FILTER (WHERE NOT x.price_missing), 0),
                        'missing_price_rows', count(*) FILTER (WHERE x.price_missing),
                        'missing_price_quantity', COALESCE(sum(x.closing) FILTER (WHERE x.price_missing), 0))
                        FROM x))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_stock_movement_report(DATE, DATE, TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_stock_movement_report(DATE, DATE, TEXT, TEXT, TEXT, INT) TO authenticated;

-- 6c. One variant's movements in a date range: the opening balance, then every movement by
--     date/time and id, with the running balance (previous + in − out). The ledger's opening
--     balance is part of the opening line, never a movement row (counted once).
-- {variant: {...}, from, to, generated_at, opening, closing, rows: [{id, occurred_at, movement_type,
--  reference, source_type, source_id, qty_in, qty_out, balance, recorded_by, note}]}
CREATE OR REPLACE FUNCTION public.admin_stock_movement_history(p_variant_id INT, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_start   TIMESTAMPTZ;
  v_end     TIMESTAMPTZ;
  v_opening INT;
  v_variant JSONB;
  v_rows    JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can see stock reports.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_from < DATE '2000-01-01' OR p_to > DATE '2999-12-31' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_range:Choose a start date on or before the end date.';
  END IF;
  SELECT jsonb_build_object('variant_id', f.variant_id, 'product_id', f.product_id, 'code', f.code,
                            'product_name', f.product_name, 'brand', f.brand, 'variant_name', f.variant_name,
                            'specs', f.specs, 'category_name', f.category_name, 'tracked', f.tracked,
                            'price', CASE WHEN f.price <= 0 THEN NULL ELSE f.price END, 'price_missing', f.price <= 0)
    INTO v_variant
    FROM public._stock_report_variants(NULL, NULL, NULL, p_variant_id) f;
  IF v_variant IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'variant_not_found:That product variant no longer exists.';
  END IF;
  v_start := p_from::timestamp AT TIME ZONE 'Asia/Colombo';
  v_end   := (p_to + 1)::timestamp AT TIME ZONE 'Asia/Colombo';

  SELECT COALESCE(sum(m.qty_in - m.qty_out), 0)::INT INTO v_opening
    FROM public.stock_movements m
   WHERE m.variant_id = p_variant_id AND m.occurred_at < v_end
     AND (m.occurred_at < v_start OR m.movement_type = 'opening');

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', t.id, 'occurred_at', t.occurred_at, 'movement_type', t.movement_type,
           'reference', t.reference, 'source_type', t.source_type, 'source_id', t.source_id,
           'qty_in', t.qty_in, 'qty_out', t.qty_out, 'balance', t.balance,
           'recorded_by', t.recorded_by, 'note', t.note) ORDER BY t.occurred_at, t.id), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT m.id, m.occurred_at, m.movement_type, m.source_type, m.source_id, m.qty_in, m.qty_out, m.note,
                 CASE m.source_type
                   WHEN 'order'   THEN m.source_id
                   WHEN 'invoice' THEN COALESCE(inv.number, 'Draft invoice')
                   ELSE m.reference
                 END AS reference,
                 v_opening + sum(m.qty_in - m.qty_out) OVER (ORDER BY m.occurred_at, m.id) AS balance,
                 COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email) AS recorded_by
            FROM public.stock_movements m
            LEFT JOIN public.invoices inv ON m.source_type = 'invoice' AND inv.id::text = m.source_id
            LEFT JOIN public.customers c ON c.id = m.recorded_by
           WHERE m.variant_id = p_variant_id AND m.occurred_at >= v_start AND m.occurred_at < v_end
             AND m.movement_type <> 'opening') t;

  RETURN jsonb_build_object(
    'variant', v_variant, 'from', p_from, 'to', p_to, 'generated_at', now(),
    'opening', v_opening,
    'closing', v_opening + COALESCE((SELECT sum((e ->> 'qty_in')::INT - (e ->> 'qty_out')::INT) FROM jsonb_array_elements(v_rows) e), 0),
    'rows', v_rows);
END $$;
REVOKE ALL ON FUNCTION public.admin_stock_movement_history(INT, DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_stock_movement_history(INT, DATE, DATE) TO authenticated;

-- 6d. Filter lists: categories and brands of the catalogue, and every variant a report can show
--     (tracked, or with movements) — {categories: [{id, name}], brands: [..], variants: [{variant_id,
--     product_id, code, label, tracked}], ledger_started}
CREATE OR REPLACE FUNCTION public.admin_stock_report_options()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can see stock reports.';
  END IF;
  WITH f AS (
    SELECT * FROM public._stock_report_variants(NULL, NULL, NULL, NULL) x
     WHERE x.tracked OR EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.variant_id = x.variant_id)
  )
  SELECT jsonb_build_object(
           'categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.sort_order, c.name)
                                     FROM public.categories c), '[]'::jsonb),
           'brands', COALESCE((SELECT jsonb_agg(b.brand ORDER BY lower(b.brand))
                                 FROM (SELECT DISTINCT ON (lower(f.brand)) f.brand FROM f ORDER BY lower(f.brand), f.brand) b), '[]'::jsonb),
           'variants', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                          'variant_id', f.variant_id, 'product_id', f.product_id, 'code', f.code,
                                          'label', concat_ws(' — ', CASE WHEN lower(f.product_name) LIKE lower(f.brand) || '%' THEN f.product_name
                                                                         ELSE f.brand || ' ' || f.product_name END, f.variant_name),
                                          'tracked', f.tracked)
                                        ORDER BY lower(f.brand || ' ' || f.product_name), f.sort_position, f.variant_id)
                                   FROM f), '[]'::jsonb),
           'ledger_started', (SELECT value::timestamptz FROM public.app_config WHERE name = 'stock_ledger_started'))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_stock_report_options() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_stock_report_options() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 38_stock_movements
--   Run once after 01–37. It posts every tracked variant's stock on hand as its opening balance
--   (dated when you run it) — movement reports start from that moment. Nothing else to configure.
--   Record deliveries, customer returns, supplier returns and adjustments in admin → Inventory →
--   Record movement; editing a stock number directly is logged as an adjustment.
--   Verification:
--     SELECT value FROM public.app_config WHERE name = 'stock_ledger_started';
--     -- the ledger agrees with the stock (expect no rows):
--     SELECT i.variant_id, i.stock_level, public._stock_reserved(i.variant_id) AS reserved,
--            public._stock_balance(i.variant_id) AS ledger
--       FROM public.inventory i
--      WHERE public._stock_balance(i.variant_id) <> i.stock_level + public._stock_reserved(i.variant_id);
--     SELECT has_table_privilege('anon', 'public.stock_movements', 'SELECT');                    -- false
--     SELECT has_table_privilege('authenticated', 'public.stock_movements', 'INSERT');           -- false
--     SELECT public.admin_inventory_value_report() -> 'totals';    -- as an admin (SQL editor: is_admin() is false)
--   Latest movements:
--     SELECT m.occurred_at, m.movement_type, m.qty_in, m.qty_out, m.source_type, m.source_id, m.reference
--       FROM public.stock_movements m ORDER BY m.occurred_at DESC, m.id DESC LIMIT 50;
-- ═════════════════════════════════════════════════════════════════════════════
