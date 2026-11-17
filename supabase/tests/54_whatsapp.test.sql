-- 54_whatsapp.test.sql — WhatsApp Business from the admin: the sealed settings (keys written, never
-- read back), the owner-only save and its checks, the status staff may see, Meta's verify call,
-- signed webhooks (bad signature refused, messages stored once, other numbers ignored, statuses
-- only move forward, the AI's turn and its pause after a person replies), sending (credentials only
-- for the owner or staff through the site's server), recording sent messages, the chat switches,
-- the new staff section, and a re-run.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner54@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;
-- Meta's signature over a body with our app secret
CREATE FUNCTION pg_temp.sig(p_body text, p_secret text DEFAULT 'app-secret-54-abcdef') RETURNS text LANGUAGE sql AS $$
  SELECT 'sha256=' || encode(extensions.hmac(convert_to(p_body, 'UTF8'), convert_to(p_secret, 'UTF8'), 'sha256'), 'hex')
$$;
-- a Meta webhook body: contacts + messages + statuses for a phone number id
CREATE FUNCTION pg_temp.hook(p_phone_id text, p_messages jsonb, p_statuses jsonb DEFAULT '[]', p_contacts jsonb DEFAULT '[]') RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('object', 'whatsapp_business_account', 'entry', jsonb_build_array(jsonb_build_object(
           'id', '1111', 'changes', jsonb_build_array(jsonb_build_object('field', 'messages', 'value', jsonb_build_object(
             'messaging_product', 'whatsapp', 'metadata', jsonb_build_object('display_phone_number', '94710960006', 'phone_number_id', p_phone_id),
             'contacts', p_contacts, 'messages', p_messages, 'statuses', p_statuses))))))::text
$$;

-- ── 1. sealed settings, owner-only keys ──────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.whatsapp_settings), 1::bigint, 'one settings row');
SELECT pg_temp.ok((SELECT verify_token ~ '^[0-9a-f]{32}$' FROM public.whatsapp_settings), 'a random verify token is made for Meta''s webhook');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT count(*) FROM public.whatsapp_settings$$, '42501', 'the settings table is sealed even from the owner''s session');
SELECT pg_temp.eq((public.admin_whatsapp_status() ->> 'configured'), 'false', 'not connected at first');
SELECT pg_temp.throws($$SELECT public.admin_save_whatsapp_settings('{"phone_number_id": "12ab"}')$$, '22023', 'a phone number id is digits', 'invalid_whatsapp:%');
SELECT pg_temp.throws($$SELECT public.admin_save_whatsapp_settings('{"access_token": "short"}')$$, '22023', 'a token must look like one', 'invalid_whatsapp:%');
SELECT pg_temp.throws($$SELECT public.admin_save_whatsapp_settings('{"invoice_template": "Invoice PDF"}')$$, '22023', 'template names are lower-case', 'invalid_whatsapp:%');
SELECT pg_temp.throws($$SELECT public.admin_save_whatsapp_settings('{"webhook": "x"}')$$, '22023', 'unknown fields are refused', 'invalid_whatsapp:%');
SELECT set_config('t.st', public.admin_save_whatsapp_settings(jsonb_build_object(
  'phone_number_id', ' 106540352242922 ', 'business_account_id', '102290129340398',
  'access_token', 'EAAGtest' || repeat('x', 60), 'app_secret', 'app-secret-54-abcdef',
  'invoice_template', 'invoice_pdf', 'ai_auto_reply', TRUE, 'ai_pause_hours', 6))::text, false);
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s', current_setting('t.st')::jsonb ->> 'configured', current_setting('t.st')::jsonb ->> 'phone_number_id',
                         current_setting('t.st')::jsonb ->> 'token_set', current_setting('t.st')::jsonb ->> 'app_secret_set', current_setting('t.st')::jsonb ->> 'invoice_template'),
                  'true|106540352242922|true|true|invoice_pdf', 'the owner saves the keys (spaces trimmed); the status says they are set');
SELECT pg_temp.ok(position('EAAGtest' IN current_setting('t.st')) = 0 AND position('app-secret-54' IN current_setting('t.st')) = 0,
                  'the token and the app secret are never sent back');
SELECT public.admin_save_whatsapp_settings('{"access_token": "", "app_secret": ""}');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s', left(access_token, 8), app_secret) FROM public.whatsapp_settings), 'EAAGtest|app-secret-54-abcdef',
                  'empty fields keep the saved keys (the form never shows them)');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_whatsapp_connection_result('{"ok": true, "display_phone": "+94 71 096 0006", "verified_name": "Dock One Solutions"}');
SELECT pg_temp.eq(format('%s|%s', public.admin_whatsapp_status() ->> 'display_phone', (public.admin_whatsapp_status() ->> 'connected_at') IS NOT NULL),
                  '+94 71 096 0006|t', 'a successful test marks it connected with the number Meta reports');
SELECT set_config('t.wa_staff', public.admin_create_staff('wa54@shop.test', 'Counter2026', 'Nimesha', '{"whatsapp": "edit"}') ->> 'user_id', false);
SELECT set_config('t.wa_view', public.admin_create_staff('waview54@shop.test', 'Counter2026', 'Viewer', '{"whatsapp": "view"}') ->> 'user_id', false);
SELECT set_config('t.inv_staff', public.admin_create_staff('inv54@shop.test', 'Counter2026', 'Kasun', '{"invoices": "edit"}') ->> 'user_id', false);
SELECT pg_temp.logout();
SELECT pg_temp.ok(public._staff_area_keys() @> ARRAY['whatsapp'], 'WhatsApp is a section staff can be given');
SELECT pg_temp.login(current_setting('t.wa_view')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_whatsapp_status');
SELECT pg_temp.eq(format('%s|%s', public.admin_whatsapp_status() ->> 'configured', public.admin_whatsapp_status() ->> 'verify_token'), 'true|',
                  'staff see whether it is connected, but not the verify token');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_whatsapp_settings');
SELECT pg_temp.throws($$SELECT public.admin_save_whatsapp_settings('{"ai_auto_reply": false}')$$, '42501', 'staff can''t change the keys or switches', 'not_authorised:%');
SELECT pg_temp.req('', '');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.admin_whatsapp_status()$$, '42501', 'shoppers can''t see the status');
SELECT pg_temp.throws($$SELECT public.whatsapp_send_credentials()$$, '42501', 'or get the keys');

-- ── 2. Meta's verify call ───────────────────────────────────────────────────
SELECT pg_temp.logout();
SELECT set_config('t.vt', (SELECT verify_token FROM public.whatsapp_settings), false);
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.whatsapp_verify_webhook(current_setting('t.vt')), TRUE, 'the right verify token is accepted');
SELECT pg_temp.eq(public.whatsapp_verify_webhook('wrong-token-0000000000'), FALSE, 'a wrong one is not');

-- ── 3. the webhook: signed messages and statuses ─────────────────────────────
SELECT set_config('t.b1', pg_temp.hook('106540352242922',
  '[{"from": "94771234567", "id": "wamid.IN1", "timestamp": "1794880000", "type": "text", "text": {"body": "Do you have the Vivobook 15 in stock?"}},
    {"from": "94771234567", "id": "wamid.IN2", "timestamp": "1794880005", "type": "image", "image": {"id": "MEDIA1", "mime_type": "image/jpeg", "caption": "This one"}}]',
  '[]', '[{"wa_id": "94771234567", "profile": {"name": "Ama Perera"}}]'), false);
SELECT pg_temp.throws(format('SELECT public.whatsapp_receive(%L, %L)', current_setting('t.b1'), 'sha256=' || repeat('0', 64)), 'P0001', 'a wrong signature is refused', 'bad_signature');
SELECT pg_temp.throws(format('SELECT public.whatsapp_receive(%L, NULL)', current_setting('t.b1')), 'P0001', 'no signature is refused', 'bad_signature');
SELECT set_config('t.r1', public.whatsapp_receive(current_setting('t.b1'), pg_temp.sig(current_setting('t.b1')))::text, false);
SELECT pg_temp.eq(format('%s|%s', current_setting('t.r1')::jsonb ->> 'received', jsonb_array_length(current_setting('t.r1')::jsonb -> 'ai')), '2|1',
                  'two messages stored; the AI is asked to answer the text one (not the photo)');
SELECT pg_temp.eq((current_setting('t.r1')::jsonb #>> '{ai,0,text}'), 'Do you have the Vivobook 15 in stock?', 'with the customer''s words');
SELECT pg_temp.eq((current_setting('t.r1')::jsonb #>> '{credentials,phone_number_id}'), '106540352242922', 'and the keys to answer with (Meta signed this request)');
SELECT pg_temp.eq(public.whatsapp_receive(current_setting('t.b1'), pg_temp.sig(current_setting('t.b1'))) ->> 'received', '0', 'Meta sending it again stores nothing twice');
SELECT pg_temp.eq(public.whatsapp_receive(pg_temp.hook('999999', '[{"from": "94770000000", "id": "wamid.OTHER", "type": "text", "text": {"body": "hi"}}]'),
                                          pg_temp.sig(pg_temp.hook('999999', '[{"from": "94770000000", "id": "wamid.OTHER", "type": "text", "text": {"body": "hi"}}]'))) ->> 'received',
                  '0', 'messages to another number of the same Meta app are ignored');
SELECT pg_temp.throws($$SELECT count(*) FROM public.whatsapp_messages$$, '42501', 'shoppers can''t read chats');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', name, wa_id, unread_count, last_preview) FROM public.whatsapp_conversations WHERE wa_id = '94771234567'),
                  'Ama Perera|94771234567|2|This one', 'one chat per number, named from WhatsApp, 2 unread, the latest line as preview');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', kind, body), ' / ' ORDER BY id) FROM public.whatsapp_messages), 'text:Do you have the Vivobook 15 in stock? / image:This one',
                  'what each message said');

-- ── 4. sending: credentials, recording, the AI stepping back ────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(left(public.whatsapp_send_credentials() ->> 'access_token', 8), 'EAAGtest', 'the owner''s session gets the keys (for the server to send)');
SELECT set_config('t.out', public.admin_whatsapp_record_outbound(jsonb_build_object('to', '077 123 4567', 'wa_message_id', 'wamid.OUT1', 'kind', 'text',
                                                                                   'body', 'Yes — in stock at Unity Plaza.', 'status', 'sent'))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s', unread_count, last_preview, last_human_reply_at IS NOT NULL) FROM public.whatsapp_conversations WHERE wa_id = '94771234567'),
                  '0|Yes — in stock at Unity Plaza.|t', 'a reply from the admin lands in the same chat (077… = 94 77…), clears unread, notes a person replied');
-- the customer writes again: the AI stays quiet while a person handles the chat (6-hour pause)
SELECT set_config('t.b2', pg_temp.hook('106540352242922', '[{"from": "94771234567", "id": "wamid.IN3", "type": "text", "text": {"body": "Great, I will come today"}}]'), false);
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(jsonb_array_length(public.whatsapp_receive(current_setting('t.b2'), pg_temp.sig(current_setting('t.b2'))) -> 'ai'), 0,
                  'after a person replied, the AI waits (no AI turn, no keys handed out)');
SELECT pg_temp.logout();
UPDATE public.whatsapp_conversations SET last_human_reply_at = now() - interval '7 hours' WHERE wa_id = '94771234567';
SELECT set_config('t.b3', pg_temp.hook('106540352242922', '[{"from": "94771234567", "id": "wamid.IN4", "type": "text", "text": {"body": "What time do you close?"}}]'), false);
SELECT pg_temp.login_anon();
SELECT set_config('t.r3', public.whatsapp_receive(current_setting('t.b3'), pg_temp.sig(current_setting('t.b3')))::text, false);
SELECT pg_temp.eq(jsonb_array_length(current_setting('t.r3')::jsonb -> 'ai'), 1, 'once the pause has passed, the AI answers again');
SELECT pg_temp.ok(jsonb_array_length(current_setting('t.r3')::jsonb #> '{ai,0,history}') >= 3, 'with the chat so far for context');
SELECT public.whatsapp_record_ai_reply(current_setting('t.b3'), pg_temp.sig(current_setting('t.b3')),
                                       jsonb_build_object('conversation_id', (current_setting('t.r3')::jsonb #>> '{ai,0,conversation_id}')::int,
                                                          'wa_message_id', 'wamid.AI1', 'body', 'We are open until 7 pm.', 'status', 'sent'));
SELECT pg_temp.throws(format('SELECT public.whatsapp_record_ai_reply(%L, %L, %L)', current_setting('t.b3'), 'sha256=' || repeat('1', 64),
                             '{"conversation_id": 1, "body": "forged", "status": "sent"}'), 'P0001', 'an AI reply needs the signed webhook', 'bad_signature');
-- statuses move forward only
SELECT set_config('t.b4', pg_temp.hook('106540352242922', '[]', '[{"id": "wamid.OUT1", "status": "read"}, {"id": "wamid.AI1", "status": "delivered"}]'), false);
SELECT public.whatsapp_receive(current_setting('t.b4'), pg_temp.sig(current_setting('t.b4')));
SELECT set_config('t.b5', pg_temp.hook('106540352242922', '[]', '[{"id": "wamid.OUT1", "status": "delivered"}]'), false);
SELECT public.whatsapp_receive(current_setting('t.b5'), pg_temp.sig(current_setting('t.b5')));
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', wa_message_id, status, sent_by_ai), ' ' ORDER BY id) FROM public.whatsapp_messages WHERE direction = 'out'),
                  'wamid.OUT1:read:f wamid.AI1:delivered:t', 'read stays read when a late "delivered" arrives; the AI''s message is marked as the AI''s');

-- the chat's own switch
SELECT pg_temp.login(current_setting('t.wa_view')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_whatsapp_update_conversation');
SELECT pg_temp.eq((public.admin_whatsapp_update_conversation((SELECT id FROM public.whatsapp_conversations WHERE wa_id = '94771234567'), '{"read": true}') ->> 'unread_count'), '0',
                  'a viewer opening the chat marks it read');
SELECT pg_temp.throws(format($$SELECT public.admin_whatsapp_update_conversation(%s, '{"ai_enabled": false}')$$, (SELECT id FROM public.whatsapp_conversations WHERE wa_id = '94771234567')),
                      '42501', 'but can''t switch the AI off there', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.wa_staff')::uuid);
SELECT public.admin_whatsapp_update_conversation((SELECT id FROM public.whatsapp_conversations WHERE wa_id = '94771234567'), '{"ai_enabled": false}');
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
UPDATE public.whatsapp_conversations SET last_human_reply_at = NULL WHERE wa_id = '94771234567';
SELECT set_config('t.b6', pg_temp.hook('106540352242922', '[{"from": "94771234567", "id": "wamid.IN5", "type": "text", "text": {"body": "Hello?"}}]'), false);
SELECT pg_temp.eq(jsonb_array_length(public.whatsapp_receive(current_setting('t.b6'), pg_temp.sig(current_setting('t.b6'))) -> 'ai'), 0,
                  'with the AI switched off in a chat, it never answers there');

-- staff and the site's own server
INSERT INTO public.app_config (name, value) VALUES ('rate_limit', 'route_secret_54_0123456789abcdef') ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;
SELECT pg_temp.login(current_setting('t.inv_staff')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/whatsapp_send_credentials');
SELECT set_config('request.headers', '', false);
SELECT pg_temp.throws($$SELECT public.whatsapp_send_credentials()$$, '42501', 'staff calling directly (not through the site''s server) never get the keys', 'not_authorised:%');
SELECT set_config('request.headers', json_build_object('x-dockone-route',
  encode(extensions.hmac('dockone-route-v1', 'route_secret_54_0123456789abcdef', 'sha256'), 'hex'))::text, false);
SELECT pg_temp.eq(left(public.whatsapp_send_credentials() ->> 'access_token', 8), 'EAAGtest', 'staff with Invoices → edit send through the server (an invoice on WhatsApp)');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_whatsapp_record_outbound');
SELECT pg_temp.eq((public.admin_whatsapp_record_outbound(jsonb_build_object('to', '+94 76 555 1234', 'name', 'Kamal', 'kind', 'document',
                    'media_filename', 'INV-0042.pdf', 'status', 'failed', 'error', 'Template not approved')) ->> 'message_id') IS NOT NULL, TRUE,
                  'a refused send is recorded too, with the reason');
SELECT pg_temp.login(current_setting('t.wa_view')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/whatsapp_send_credentials');
SELECT pg_temp.throws($$SELECT public.whatsapp_send_credentials()$$, '42501', 'WhatsApp → view can''t send', 'not_authorised:%');
SELECT pg_temp.req('GET', '/rest/v1/whatsapp_messages');
SELECT pg_temp.eq((SELECT count(*) FROM public.whatsapp_messages), 8::bigint, 'but reads every message');
SELECT set_config('request.headers', '', false);
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s', name, (SELECT status FROM public.whatsapp_messages m WHERE m.conversation_id = c.id))
                     FROM public.whatsapp_conversations c WHERE wa_id = '94765551234'), 'Kamal|failed', 'a new chat for a new number, named by staff');

-- the 24-hour window (free-form messages only within 24 hours of the customer's last message)
SELECT pg_temp.login(current_setting('t.inv_staff')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_whatsapp_window');
SELECT pg_temp.eq(format('%s|%s', public.admin_whatsapp_window('077 123 4567') ->> 'wa_id', public.admin_whatsapp_window('077 123 4567') ->> 'open'),
                  '94771234567|true', 'a customer who wrote today: the window is open (any way the number is typed)');
SELECT pg_temp.eq(format('%s|%s', public.admin_whatsapp_window('+94 76 555 1234') ->> 'valid', public.admin_whatsapp_window('+94 76 555 1234') ->> 'open'),
                  'true|false', 'a number that never wrote: only a template can go');
SELECT pg_temp.eq(public.admin_whatsapp_window('call me') ->> 'valid', 'false', 'not a phone number');
SELECT pg_temp.login(current_setting('t.wa_view')::uuid);
SELECT pg_temp.eq(public.admin_whatsapp_window('0771234567') ->> 'open', 'true', 'WhatsApp → view sees it too');
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
UPDATE public.whatsapp_conversations SET last_inbound_at = now() - interval '25 hours' WHERE wa_id = '94771234567';
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.admin_whatsapp_window('0771234567') ->> 'open', 'false', 'after 24 hours the window is closed');
SELECT pg_temp.logout();
SELECT pg_temp.login(pg_temp.new_user('shopper54@shop.test'));
SELECT pg_temp.throws($$SELECT public.admin_whatsapp_window('0771234567')$$, '42501', 'a shopper can''t ask', 'not_authorised:%');
SELECT pg_temp.logout();

-- ── 5. staff map and re-run ─────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.staff_api_map WHERE migration = '54'), 12::bigint, 'twelve staff map rows');
\ir ../migrations/54_whatsapp.sql
SELECT pg_temp.eq((SELECT format('%s|%s|%s', phone_number_id, left(access_token, 8), verify_token = current_setting('t.vt')) FROM public.whatsapp_settings),
                  '106540352242922|EAAGtest|t', 'a re-run keeps the keys and the verify token');
SELECT pg_temp.eq((SELECT count(*) FROM public.whatsapp_conversations), 2::bigint, 'and the chats');
