-- 19_assistant_core.test.sql — redact_pii (emails, Sri Lankan phone shapes, 7+ digit runs, DO-
-- order numbers; prices and specs survive), log_assistant_turn (one write per turn, clamps,
-- redaction of text/search terms/photo reading, unknown outcome → NULL, hashed client key only,
-- ≤ 400 messages, swallows errors), RLS, and the admin insights (42501 for non-admins; exact
-- overview figures, sessions list + struggles filter, transcript).
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);
CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;
CREATE FUNCTION pg_temp.msg(p_session uuid, p_role text) RETURNS public.assistant_messages LANGUAGE sql AS
  $$ SELECT * FROM public.assistant_messages WHERE session_id = p_session AND role = p_role ORDER BY id DESC LIMIT 1 $$;

-- ── redact_pii ──────────────────────────────────────────────────────────────
SELECT pg_temp.eq(public.redact_pii('mail me at a.b@c.com or +94 77 123 4567 about DO-10023, budget 300000'),
                  'mail me at [email] or [number] about [order], budget 300000', 'the OPS NOTE example');
SELECT pg_temp.eq(public.redact_pii('call 077 123 4567 or 0771234567 or (011) 234-5678'),
                  'call [number] or [number] or [number]', 'Sri Lankan mobile and landline shapes');
SELECT pg_temp.eq(public.redact_pii('ref 12345678 and do 10001 and DO10002 and do-10003'),
                  'ref [number] and [order] and [order] and [order]', '7+ digit runs and order numbers in any case');
SELECT pg_temp.eq(public.redact_pii('Rs. 489,900 for the RTX 4060 16GB/1TB model, not 1000 things; can you do 999 off?'),
                  'Rs. 489,900 for the RTX 4060 16GB/1TB model, not 1000 things; can you do 999 off?', 'prices, specs and short numbers survive');
SELECT pg_temp.eq(public.redact_pii(NULL), NULL::text, 'NULL stays NULL');
SELECT pg_temp.eq(public.clamp_ints(ARRAY[5, NULL, 3, 9], 2), ARRAY[5, 3], 'clamp_ints keeps order, drops NULLs, caps');
SELECT pg_temp.eq(public.clamp_labels(ARRAY['  a  ', '', NULL, 'bbbbbb', 'c'], 2, 3), ARRAY['a', 'bbb'], 'clamp_labels trims, drops blanks, caps count and length');
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.redact_pii(text)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public.clamp_ints(integer[],integer)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public.clamp_labels(text[],integer,integer)', 'EXECUTE'),
                  'redaction and clamp helpers are internal');

-- ── fixtures ────────────────────────────────────────────────────────────────
INSERT INTO public.categories (id, name) VALUES ('as-cat', 'Assistant');
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('as-1', 'AsBrand', 'As One', 'as-cat'), ('as-2', 'AsBrand', 'As Two', 'as-cat');
SELECT set_config('t.p1', (SELECT id FROM public.products WHERE slug = 'as-1')::text, false);
SELECT set_config('t.p2', (SELECT id FROM public.products WHERE slug = 'as-2')::text, false);

-- ── log_assistant_turn ──────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT public.log_assistant_turn('aaaaaaaa-0000-0000-0000-000000000001',
  '  Do you have a Thunderbolt dock? Mail me at me@mail.com  ', 'Sorry — nothing like that right now.', 'no_match',
  NULL, NULL, NULL, NULL, ARRAY['search_products'], ARRAY['Thunderbolt dock', 'call 0771234567'],
  '/shop?q=dock&email=me@mail.com#x', 'gpt-5.4-mini', 1000, 100, 50, FALSE, NULL, 'ABCDEF0123456789ABCDEF0123456789', 10);
SELECT public.log_assistant_turn('aaaaaaaa-0000-0000-0000-000000000001',
  'what is this?', 'That looks like a keyboard we do not carry.', 'no_image_match',
  NULL, NULL, NULL, NULL, ARRAY['record_photo_reading', 'search_products'], ARRAY['mx keys'],
  '/shop', 'gpt-5.4-mini', 3000, 200, 60, TRUE, E'Logitech\nMX [Keys]', 'abcdef0123456789abcdef0123456789', NULL);
SELECT public.log_assistant_turn('bbbbbbbb-0000-0000-0000-000000000001',
  'gaming laptop under 500000', 'Here are two.', 'answered',
  ARRAY[current_setting('t.p1')::int, current_setting('t.p2')::int], ARRAY[current_setting('t.p1')::int], NULL, 'q-budget',
  ARRAY['search_products', 'show_products', 'suggest_replies'], ARRAY['gaming laptop'], '/', 'gpt-5.4-mini', 2000, 300, 70,
  FALSE, NULL, '10.0.0.1', 0);
SELECT public.log_assistant_turn('bbbbbbbb-0000-0000-0000-000000000001',
  'thanks', 'You''re welcome.', 'weird_outcome', NULL, NULL, ARRAY[current_setting('t.p2')::int], repeat('q', 50),
  NULL, NULL, repeat('/p', 100), repeat('m', 80), -5, NULL, 99999999, FALSE, NULL, NULL, NULL);
-- nothing is written for an empty turn or a missing session
SELECT public.log_assistant_turn(NULL, 'hello', 'hi');
SELECT public.log_assistant_turn('cccccccc-0000-0000-0000-000000000001', '   ', '');
-- clamps on id arrays
SELECT public.log_assistant_turn('dddddddd-0000-0000-0000-000000000001', 'many', 'lots',
  'answered', (SELECT array_agg(g) FROM generate_series(1, 15) g) || ARRAY[NULL::int], NULL,
  (SELECT array_agg(g) FROM generate_series(1, 20) g), NULL,
  (SELECT array_agg('tool_' || g) FROM generate_series(1, 20) g), (SELECT array_agg('term ' || g) FROM generate_series(1, 20) g));
SELECT pg_temp.throws('SELECT * FROM public.assistant_messages', '42501', 'anon cannot read transcripts');
SELECT pg_temp.throws('SELECT * FROM public.assistant_sessions', '42501', 'anon cannot read sessions');
SELECT pg_temp.throws($$INSERT INTO public.assistant_sessions (id) VALUES (gen_random_uuid())$$, '42501', 'anon cannot create sessions directly');
SELECT pg_temp.logout();

SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_sessions), 3::bigint, 'three sessions (none for the empty turn or NULL session)');
SELECT pg_temp.eq((SELECT message_count FROM public.assistant_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'), 4,
                  'the counter counts the rows written (2 per full turn)');
SELECT pg_temp.eq((SELECT client_key FROM public.assistant_sessions WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'),
                  'abcdef0123456789abcdef0123456789', 'a hex client key is stored lower-cased; the first key is kept');
SELECT pg_temp.eq((SELECT client_key FROM public.assistant_sessions WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001'), NULL::text,
                  'a raw IP is never stored as the client key');
SELECT pg_temp.eq((pg_temp.msg('aaaaaaaa-0000-0000-0000-000000000001', 'user')).content, 'what is this?', 'user text stored');
SELECT pg_temp.eq((SELECT content FROM public.assistant_messages WHERE session_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND role = 'user' ORDER BY id LIMIT 1),
                  'Do you have a Thunderbolt dock? Mail me at [email]', 'user text trimmed and redacted on the way in');
SELECT pg_temp.eq((SELECT concat_ws('|', outcome, page, model, latency_ms::text, input_tokens::text, output_tokens::text,
                                    cache_read_tokens::text, array_to_string(search_terms, ';'), array_to_string(tools_used, ';'))
                     FROM public.assistant_messages WHERE session_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND role = 'assistant' ORDER BY id LIMIT 1),
                  'no_match|/shop|gpt-5.4-mini|1000|100|50|10|Thunderbolt dock;call [number]|search_products',
                  'assistant row: outcome, path-only page, model, latency, tokens (incl. cache read), redacted search terms, tools');
SELECT pg_temp.eq((pg_temp.msg('aaaaaaaa-0000-0000-0000-000000000001', 'assistant')).photo_reading, 'Logitech MX  Keys',
                  'photo reading: newlines and brackets become spaces');
SELECT pg_temp.eq((pg_temp.msg('aaaaaaaa-0000-0000-0000-000000000001', 'user')).has_image, TRUE, 'the photo flag rides on the user row');
SELECT pg_temp.eq((SELECT concat_ws('|', COALESCE(outcome, '∅'), question_id, char_length(page)::text, char_length(model)::text,
                                    latency_ms::text, COALESCE(input_tokens::text, '∅'), output_tokens::text)
                     FROM public.assistant_messages WHERE session_id = 'bbbbbbbb-0000-0000-0000-000000000001' AND role = 'assistant' ORDER BY id DESC LIMIT 1),
                  '∅|' || repeat('q', 32) || '|120|60|0|∅|10000000',
                  'unknown outcome → NULL; question id, page and model capped; latency clamped at 0; NULL tokens stay NULL; tokens capped');
SELECT pg_temp.eq((pg_temp.msg('bbbbbbbb-0000-0000-0000-000000000001', 'user')).tapped_product_ids, ARRAY[current_setting('t.p2')::int],
                  'tapped ids ride on the user row');
SELECT pg_temp.eq((SELECT concat_ws('|', cardinality(product_ids)::text, array_to_string(product_ids, ','))
                     FROM public.assistant_messages WHERE session_id = 'dddddddd-0000-0000-0000-000000000001' AND role = 'assistant'),
                  '12|1,2,3,4,5,6,7,8,9,10,11,12', 'shown ids clamped to the first 12 non-NULL');
SELECT pg_temp.eq((SELECT concat_ws('|', cardinality(tools_used)::text, cardinality(search_terms)::text)
                     FROM public.assistant_messages WHERE session_id = 'dddddddd-0000-0000-0000-000000000001' AND role = 'assistant'),
                  '12|8', 'tools clamped to 12, search terms to 8');
SELECT pg_temp.eq((pg_temp.msg('dddddddd-0000-0000-0000-000000000001', 'user')).tapped_product_ids, (SELECT array_agg(g) FROM generate_series(1, 12) g),
                  'tapped ids clamped to 12');

-- ≤ 400 messages per session
UPDATE public.assistant_sessions SET message_count = 399 WHERE id = 'dddddddd-0000-0000-0000-000000000001';
SELECT pg_temp.login_anon();
SELECT public.log_assistant_turn('dddddddd-0000-0000-0000-000000000001', 'one more', 'no room');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_messages WHERE session_id = 'dddddddd-0000-0000-0000-000000000001'), 2::bigint,
                  'past 400 messages a session stores nothing more');

-- the logger swallows its own errors
CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
CREATE TRIGGER zz_boom BEFORE INSERT ON public.assistant_messages FOR EACH ROW EXECUTE FUNCTION pg_temp.boom();
SELECT pg_temp.login_anon();
DO $$ BEGIN
  PERFORM public.log_assistant_turn('eeeeeeee-0000-0000-0000-000000000001', 'hello', 'hi');
  RAISE NOTICE 'PASS: a failing insert is swallowed: the call returns normally';
END $$;
SELECT pg_temp.logout();
DROP TRIGGER zz_boom ON public.assistant_messages;
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_sessions WHERE id = 'eeeeeeee-0000-0000-0000-000000000001'), 0::bigint,
                  '…and the whole turn rolled back (no half-written session)');

-- an old session outside the 30-day window
SELECT pg_temp.login_anon();
SELECT public.log_assistant_turn('ffffffff-0000-0000-0000-000000000001', 'old question', 'old answer', 'no_tools', NULL, NULL, NULL, NULL, NULL, ARRAY['old term']);
SELECT pg_temp.logout();
UPDATE public.assistant_messages SET created_at = now() - interval '40 days' WHERE session_id = 'ffffffff-0000-0000-0000-000000000001';
UPDATE public.assistant_sessions SET created_at = now() - interval '40 days', last_seen_at = now() - interval '40 days'
 WHERE id = 'ffffffff-0000-0000-0000-000000000001';
DELETE FROM public.assistant_sessions WHERE id = 'dddddddd-0000-0000-0000-000000000001';

-- ── RLS and admin-only insights ─────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_messages), 0::bigint, 'a shopper reads no transcripts');
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_sessions), 0::bigint, 'a shopper reads no sessions');
SELECT pg_temp.throws($$UPDATE public.assistant_messages SET content = 'x'$$, '42501', 'a shopper cannot edit transcripts');
SELECT pg_temp.throws('SELECT public.admin_assistant_overview(30)', '42501', 'shopper: overview refused', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_assistant_sessions(30, FALSE, 50, 0)', '42501', 'shopper: sessions refused', 'not_authorised:%');
SELECT pg_temp.throws($$SELECT * FROM public.admin_assistant_transcript('aaaaaaaa-0000-0000-0000-000000000001')$$, '42501',
                      'shopper: transcript refused', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_messages), 10::bigint, 'the admin reads transcripts');
SELECT pg_temp.throws($$DELETE FROM public.assistant_messages$$, '42501', 'even an admin cannot delete messages directly (retention / forget do that)');
SELECT set_config('t.ov', public.admin_assistant_overview(30)::text, false);
SELECT set_config('t.ss', public.admin_assistant_sessions(30, FALSE, 50, 0)::text, false);
SELECT set_config('t.ssf', public.admin_assistant_sessions(30, TRUE, 50, 0)::text, false);
SELECT set_config('t.ss1', public.admin_assistant_sessions(30, FALSE, 1, 1)::text, false);
SELECT set_config('t.tr', (SELECT string_agg(role || ':' || rtrim(left(content, 12)), ' / ' ORDER BY id)
                             FROM public.admin_assistant_transcript('aaaaaaaa-0000-0000-0000-000000000001')), false);
SELECT pg_temp.logout();

SELECT pg_temp.eq(pg_temp.j('ov') -> 'totals',
                  '{"sessions":2,"turns":4,"adds":2,"photos":1,"struggles":2,"median_latency_ms":1500,
                    "input_tokens":600,"output_tokens":10000180,"cache_read_tokens":10}'::jsonb,
                  'overview totals: sessions, turns, adds (agent adds + shopper taps), photos, struggles, median latency (0, 1000, 2000, 3000 → 1500), tokens');
SELECT pg_temp.eq(pg_temp.j('ov') -> 'outcomes',
                  '{"truncated":0,"bad_ids":0,"no_image_match":1,"no_match":1,"no_tools":0,"dead_end":0,"answered":2,"failed":0}'::jsonb,
                  'outcome mix: every label listed; an unclassified turn counts as answered; the 40-day-old turn is outside');
SELECT pg_temp.eq((SELECT sum(value::int) FROM jsonb_each_text(pg_temp.j('ov') -> 'hours')), 4::bigint, 'busy hours: 4 user messages in the window');
SELECT pg_temp.eq((SELECT count(*) FROM jsonb_object_keys(pg_temp.j('ov') -> 'hours')), 24::bigint, 'busy hours: all 24 local hours listed');
SELECT pg_temp.eq(pg_temp.j('ov') -> 'terms',
                  '[{"term":"call [number]","turns":1},{"term":"gaming laptop","turns":1},{"term":"mx keys","turns":1},{"term":"thunderbolt dock","turns":1}]'::jsonb,
                  'top assistant search terms (lower-cased, redacted)');
SELECT pg_temp.eq(pg_temp.j('ov') -> 'zero_result_terms',
                  '[{"term":"call [number]","turns":1},{"term":"mx keys","turns":1},{"term":"thunderbolt dock","turns":1}]'::jsonb,
                  'zero-result terms come from no_match / no_image_match turns');
SELECT pg_temp.eq(pg_temp.j('ov') -> 'demand',
                  jsonb_build_array(
                    jsonb_build_object('product_id', current_setting('t.p1')::int, 'brand', 'AsBrand', 'name', 'As One', 'shown', 1, 'taken', 1),
                    jsonb_build_object('product_id', current_setting('t.p2')::int, 'brand', 'AsBrand', 'name', 'As Two', 'shown', 1, 'taken', 1)),
                  'demand: shown vs taken per product');
SELECT pg_temp.eq(pg_temp.j('ov') -> 'photo_demand', '[{"reading":"logitech mx  keys","turns":1}]'::jsonb,
                  'photo demand: readings on no_image_match turns');
SELECT pg_temp.eq(pg_temp.j('ov') -> 'tools',
                  '[{"tool":"search_products","calls":3},{"tool":"record_photo_reading","calls":1},{"tool":"show_products","calls":1},{"tool":"suggest_replies","calls":1}]'::jsonb,
                  'tool usage');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('ss') ->> 'total', (SELECT string_agg(left(i ->> 'session_id', 8) || ':' || (i ->> 'struggles') || ':' || (i ->> 'turns'), ',')
                                                                 FROM jsonb_array_elements(pg_temp.j('ss') -> 'items') i)),
                  '2|bbbbbbbb:0:2,aaaaaaaa:2:2', 'sessions list: newest first, with struggles and turns');
SELECT pg_temp.eq((SELECT concat_ws('|', i ->> 'first_message', i ->> 'last_outcome', i ->> 'adds', i ->> 'photos')
                     FROM jsonb_array_elements(pg_temp.j('ss') -> 'items') i WHERE i ->> 'session_id' LIKE 'aaaaaaaa%'),
                  'Do you have a Thunderbolt dock? Mail me at [email]|no_image_match|0|1', 'session row: redacted first message, last outcome');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('ssf') ->> 'total', (SELECT string_agg(left(i ->> 'session_id', 8), ',') FROM jsonb_array_elements(pg_temp.j('ssf') -> 'items') i)),
                  '1|aaaaaaaa', 'the struggles filter');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('ss1') ->> 'total', (SELECT string_agg(left(i ->> 'session_id', 8), ',') FROM jsonb_array_elements(pg_temp.j('ss1') -> 'items') i)),
                  '2|aaaaaaaa', 'pagination: limit 1 offset 1');
SELECT pg_temp.eq(current_setting('t.tr'), 'user:Do you have / assistant:Sorry — noth / user:what is this / assistant:That looks l',
                  'the transcript, in order');
