-- ═════════════════════════════════════════════════════════════════════════════
-- 22_retention.sql — Dock One Solutions
--
-- PURPOSE      The daily housekeeping job (blueprint §12.5, §12.1.5, §7.5, Appendix A 18):
--              run_retention(secret) deletes what the privacy page promises not to keep and
--              returns a per-table count report. Orders are NEVER touched (kept per tax law).
--                table                     kept
--                rate_limit_hits           1 day (the longest limiter window is 1 hour; also pruned
--                                          lazily per bucket)
--                assistant_order_lookups   30 days
--                analytics_events          13 months
--                assistant_sessions        12 months after last seen (their messages cascade)
--                assistant_messages        12 months (older rows of sessions that are still active)
--                abandoned_carts           90 days after the last activity: the later of the last
--                                          autosave / conversion (updated_at) and the last reminder
--                                          (last_recovery_at)
--                finder_responses          12 months, only rows with no email and no account
-- DEPENDS ON   01_foundation (app_config, verify_job_secret, rate_limit_hits), 13_abandoned_carts,
--              14_finder, 17_analytics, 19_assistant_core, 21_assistant_memory_lookup.
-- ENABLES      POST /api/maintenance (bearer MAINTENANCE_SECRET, daily cron — WP-H).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- Secret-gated (app_config 'maintenance' = MAINTENANCE_SECRET), so it can be granted to the anon
-- key the job route uses. Errors (P0001): unauthorized (wrong/short/missing secret, or no
-- app_config row). Returns
--   {"rate_limit_hits": n, "assistant_order_lookups": n, "analytics_events": n,
--    "assistant_sessions": n, "assistant_messages": n, "abandoned_carts": n, "finder_responses": n}
-- — rows deleted per table (assistant_sessions counts sessions; their cascaded messages are not
-- counted again; assistant_messages counts the older messages of sessions that remain).
CREATE OR REPLACE FUNCTION public.run_retention(p_secret TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r JSONB := '{}'::jsonb;
  n INT;
BEGIN
  IF NOT public.verify_job_secret('maintenance', p_secret) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  DELETE FROM public.rate_limit_hits WHERE hit_at < now() - interval '1 day';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('rate_limit_hits', n);

  DELETE FROM public.assistant_order_lookups WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('assistant_order_lookups', n);

  DELETE FROM public.analytics_events WHERE created_at < now() - interval '13 months';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('analytics_events', n);

  DELETE FROM public.assistant_sessions WHERE last_seen_at < now() - interval '12 months';   -- messages cascade
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('assistant_sessions', n);

  DELETE FROM public.assistant_messages WHERE created_at < now() - interval '12 months';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('assistant_messages', n);

  -- recovery stops at 14 days, so 90 days after the last activity nothing is pending
  DELETE FROM public.abandoned_carts
   WHERE GREATEST(updated_at, COALESCE(last_recovery_at, updated_at)) < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('abandoned_carts', n);

  DELETE FROM public.finder_responses
   WHERE email IS NULL AND customer_id IS NULL AND updated_at < now() - interval '12 months';
  GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('finder_responses', n);

  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.run_retention(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_retention(TEXT) TO anon, authenticated;   -- secret-gated

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 22_retention
--   Do this or nothing is ever pruned (the privacy page's retention promises would be untrue):
--     INSERT INTO public.app_config (name, value)
--     VALUES ('maintenance', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
--     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--     SELECT value FROM public.app_config WHERE name = 'maintenance';   -- copy into MAINTENANCE_SECRET
--   then schedule daily (the same bearer secret):
--     curl -X POST https://<domain>/api/maintenance -H "Authorization: Bearer <secret>"
--   Orders, customers, reviews, newsletter subscribers and suppressions are never deleted by it.
--   Verification:
--     SELECT min(created_at) FROM public.analytics_events;          -- ≥ 13 months ago after a run
--     SELECT min(created_at) FROM public.assistant_order_lookups;   -- ≥ 30 days ago after a run
--     -- live probe (anon key is public): refuses without the secret
--     curl -s "$SUPABASE_URL/rest/v1/rpc/run_retention" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_secret":"x"}'                                   -- {"message":"unauthorized",…}
-- ═════════════════════════════════════════════════════════════════════════════
