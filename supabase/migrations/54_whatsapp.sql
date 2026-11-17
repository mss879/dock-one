-- ═════════════════════════════════════════════════════════════════════════════
-- 54_whatsapp.sql — Dock One Solutions
--
-- PURPOSE      WhatsApp Business (Meta's WhatsApp Cloud API) in the admin, set up from the admin
--              itself: the owner creates a Meta app, then pastes its keys into admin → WhatsApp
--              (no server settings to edit). From then on:
--                * customers' WhatsApp messages arrive in admin → WhatsApp (Meta calls the site's
--                  webhook, /api/whatsapp/webhook, which this database checks against the app's
--                  secret before storing anything);
--                * staff reply from the admin, and send invoices as PDF documents from the invoice
--                  screen (the client's request: "Let staff send invoice PDFs to customers");
--                * when switched on, the store's AI assistant answers customers on WhatsApp, and
--                  steps back in a chat for a few hours once a person has replied there.
--
--   whatsapp_settings       ONE row. phone_number_id, business_account_id, access_token and
--                           app_secret are what the owner pastes from Meta; verify_token is made
--                           here and pasted into Meta's webhook settings. The token and the app
--                           secret are WRITE-ONLY: no API role can read the table, and the status
--                           function only says whether they are set. The site's server gets the
--                           token for a send from whatsapp_send_credentials() (signed-in owner, or
--                           staff through the site's own server), or with a webhook that carries
--                           Meta's valid signature.
--   whatsapp_conversations  one per customer's WhatsApp number (wa_id = digits, country code first):
--                           name, last message, the 24-hour window (last_inbound_at), unread count,
--                           whether the AI may answer there.
--   whatsapp_messages       every message in and out: text / document / image …, Meta's message id,
--                           delivery status (sent → delivered → read, or failed), who sent it (a
--                           person, or the AI), the invoice a document was.
--
--   THE 24-HOUR RULE (Meta's): a free-form message can be sent only within 24 hours of the
--   customer's last message. Outside it only a pre-approved TEMPLATE may be sent — the invoice
--   template named in the settings (a document header + {{1}} name, {{2}} invoice number).
--
-- STAFF        A new admin section, "WhatsApp" (view: read the chats; edit: reply, switch the AI
--              off in a chat). Staff with Invoices → edit may send an invoice on WhatsApp. The keys
--              are the owner's alone.
-- REPLACES     _staff_area_keys (39) — the list of admin sections gains 'whatsapp'.
--              RE-RUN 54 AFTER ANY RE-RUN OF 39.
-- DEPENDS ON   01 (pgcrypto, _route_or_budget, _trusted_route_call), 02, 09 (_normalize_phone),
--              26/40 (invoices), 39 (staff).
-- ERRORS       P0001 (webhook RPCs): rate_limited, not_configured, bad_signature, invalid_payload.
--              22023 invalid_whatsapp:…, not_configured:…, conversation_not_found:…;
--              42501 not_authorised:…
-- SAFE TO RE-RUN: yes (the settings row is created once; keys are never overwritten by a re-run).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A new admin section: WhatsApp (39's list + 'whatsapp')
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._staff_area_keys()
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT ARRAY['dashboard', 'orders', 'invoices', 'quotations', 'receipts', 'expenses', 'discounts',
               'abandoned-carts', 'reports', 'products', 'categories', 'collections', 'inventory',
               'suppliers', 'warranty', 'reviews', 'customers', 'inquiries', 'subscribers',
               'finder-insights', 'assistant-insights', 'homepage', 'content', 'settings', 'site-lock',
               'costs', 'whatsapp']
$$;
REVOKE ALL ON FUNCTION public._staff_area_keys() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_settings (
  id                        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),   -- singleton
  phone_number_id           TEXT,                       -- Meta: WhatsApp → API setup → Phone number ID
  business_account_id       TEXT,                       -- Meta: WhatsApp Business Account ID
  access_token              TEXT,                       -- a permanent (system user) token — write-only
  app_secret                TEXT,                       -- the Meta app's App secret — write-only
  verify_token              TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  api_version               TEXT NOT NULL DEFAULT 'v27.0',
  display_phone             TEXT,                       -- read from Meta by "Test connection"
  verified_name             TEXT,
  ai_auto_reply             BOOLEAN NOT NULL DEFAULT FALSE,
  ai_pause_hours            INT NOT NULL DEFAULT 12,     -- after a person replies in a chat, the AI waits this long there
  invoice_template          TEXT,                       -- approved template for invoices outside the 24-hour window
  invoice_template_language TEXT NOT NULL DEFAULT 'en',
  connected_at              TIMESTAMPTZ,                -- the last successful "Test connection"
  last_error                TEXT,
  last_webhook_at           TIMESTAMPTZ,                -- the last message / status Meta sent us
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  CONSTRAINT whatsapp_settings_values_valid CHECK (
        (phone_number_id IS NULL OR phone_number_id ~ '^[0-9]{5,30}$')
    AND (business_account_id IS NULL OR business_account_id ~ '^[0-9]{5,30}$')
    AND (access_token IS NULL OR char_length(access_token) BETWEEN 20 AND 2000)
    AND (app_secret IS NULL OR char_length(app_secret) BETWEEN 8 AND 200)
    AND verify_token ~ '^[A-Za-z0-9_-]{16,80}$'
    AND api_version ~ '^v[0-9]{1,3}\.[0-9]{1,2}$'
    AND ai_pause_hours BETWEEN 0 AND 720
    AND (invoice_template IS NULL OR (char_length(invoice_template) <= 512 AND invoice_template ~ '^[a-z0-9_]+$'))
    AND invoice_template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'
    AND (display_phone IS NULL OR char_length(display_phone) <= 40)
    AND (verified_name IS NULL OR char_length(verified_name) <= 200)
    AND (last_error IS NULL OR char_length(last_error) <= 500))
);
INSERT INTO public.whatsapp_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id                  SERIAL PRIMARY KEY,
  wa_id               TEXT NOT NULL,                    -- the customer's WhatsApp number, digits (94771234567)
  name                TEXT,                             -- their WhatsApp profile name, or the name staff gave
  last_message_at     TIMESTAMPTZ,
  last_inbound_at     TIMESTAMPTZ,                      -- the 24-hour window runs from here
  last_human_reply_at TIMESTAMPTZ,                      -- the AI steps back for a while after this
  last_preview        TEXT,
  unread_count        INT NOT NULL DEFAULT 0,
  ai_enabled          BOOLEAN NOT NULL DEFAULT TRUE,    -- may the AI answer in this chat
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_conversations_wa_id_key UNIQUE (wa_id),
  CONSTRAINT whatsapp_conversations_valid CHECK (
        wa_id ~ '^[0-9]{6,20}$' AND unread_count >= 0
    AND (name IS NULL OR char_length(name) <= 120)
    AND (last_preview IS NULL OR char_length(last_preview) <= 200))
);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_recent_idx ON public.whatsapp_conversations (last_message_at DESC NULLS LAST, id DESC);

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES public.whatsapp_conversations (id) ON DELETE CASCADE,
  direction       TEXT NOT NULL,                        -- in | out
  wa_message_id   TEXT,                                 -- Meta's id (wamid…); NULL when Meta refused the send
  kind            TEXT NOT NULL,                        -- text | document | image | audio | video | sticker | location | contacts | interactive | button | reaction | template | other
  body            TEXT,                                 -- the text, a caption, or what it was ("Photo")
  media_id        TEXT,
  media_filename  TEXT,
  media_mime      TEXT,
  status          TEXT NOT NULL,                        -- in: received · out: sent | delivered | read | failed
  error           TEXT,
  sent_by         UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  sent_by_ai      BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_id      INT REFERENCES public.invoices (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_messages_valid CHECK (
        direction IN ('in', 'out')
    AND kind ~ '^[a-z_]{1,20}$'
    AND status IN ('received', 'sent', 'delivered', 'read', 'failed')
    AND (direction = 'in') = (status = 'received')
    AND (body IS NULL OR char_length(body) <= 4096)
    AND (media_filename IS NULL OR char_length(media_filename) <= 240)
    AND (media_mime IS NULL OR char_length(media_mime) <= 120)
    AND (wa_message_id IS NULL OR char_length(wa_message_id) <= 200)
    AND (error IS NULL OR char_length(error) <= 500))
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_wamid_key ON public.whatsapp_messages (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_messages_conversation_idx ON public.whatsapp_messages (conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS whatsapp_messages_invoice_idx ON public.whatsapp_messages (invoice_id) WHERE invoice_id IS NOT NULL;

-- Settings: nobody through the API (definer functions only). Chats: admins and staff with the
-- WhatsApp section read them; every write is a function below.
ALTER TABLE public.whatsapp_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages      ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_settings, public.whatsapp_conversations, public.whatsapp_messages FROM anon, authenticated;
GRANT SELECT ON public.whatsapp_conversations, public.whatsapp_messages TO authenticated;
REVOKE ALL ON SEQUENCE public.whatsapp_conversations_id_seq, public.whatsapp_messages_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS whatsapp_conversations_admin_read ON public.whatsapp_conversations;
CREATE POLICY whatsapp_conversations_admin_read ON public.whatsapp_conversations
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS whatsapp_messages_admin_read ON public.whatsapp_messages;
CREATE POLICY whatsapp_messages_admin_read ON public.whatsapp_messages
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helpers (internal)
-- ─────────────────────────────────────────────────────────────────────────────
-- A phone (any way it is typed) → WhatsApp's digits (94771234567); NULL when it isn't a number.
CREATE OR REPLACE FUNCTION public._whatsapp_wa_id(p_phone TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN btrim(COALESCE(p_phone, '')) ~ '^[0-9]{6,20}$' AND left(btrim(p_phone), 1) <> '0' THEN btrim(p_phone)
              ELSE ltrim(public._normalize_phone(p_phone), '+') END
$$;
REVOKE ALL ON FUNCTION public._whatsapp_wa_id(TEXT) FROM PUBLIC, anon, authenticated;

-- Is this Meta's signature (X-Hub-Signature-256: "sha256=<hex HMAC-SHA256 of the raw body>") with
-- the app secret? Compared as digests (constant-time in effect).
CREATE OR REPLACE FUNCTION public._whatsapp_signed(p_body TEXT, p_signature TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_secret TEXT;
  v_given  TEXT := lower(btrim(COALESCE(p_signature, '')));
BEGIN
  SELECT app_secret INTO v_secret FROM public.whatsapp_settings WHERE id;
  IF v_secret IS NULL OR p_body IS NULL OR v_given !~ '^sha256=[0-9a-f]{64}$' THEN
    RETURN FALSE;
  END IF;
  RETURN digest(substr(v_given, 8), 'sha256')
       = digest(encode(hmac(convert_to(p_body, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256'), 'hex'), 'sha256');
END $$;
REVOKE ALL ON FUNCTION public._whatsapp_signed(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- A conversation for this number (created on first contact). A name is filled in only while empty.
CREATE OR REPLACE FUNCTION public._whatsapp_conversation(p_wa_id TEXT, p_name TEXT) RETURNS public.whatsapp_conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c public.whatsapp_conversations;
BEGIN
  INSERT INTO public.whatsapp_conversations (wa_id, name)
  VALUES (p_wa_id, NULLIF(left(btrim(COALESCE(p_name, '')), 120), ''))
  ON CONFLICT (wa_id) DO UPDATE
     SET name = COALESCE(public.whatsapp_conversations.name, EXCLUDED.name)
  RETURNING * INTO c;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION public._whatsapp_conversation(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- What a message says, for the list and the AI (the text, a caption, or what kind it was).
CREATE OR REPLACE FUNCTION public._whatsapp_body(m JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT left(COALESCE(
    NULLIF(m #>> '{text,body}', ''),
    NULLIF(m #>> '{image,caption}', ''), NULLIF(m #>> '{video,caption}', ''), NULLIF(m #>> '{document,caption}', ''),
    NULLIF(m #>> '{button,text}', ''),
    NULLIF(m #>> '{interactive,button_reply,title}', ''), NULLIF(m #>> '{interactive,list_reply,title}', ''),
    CASE m ->> 'type'
      WHEN 'image'    THEN 'Photo'
      WHEN 'video'    THEN 'Video'
      WHEN 'audio'    THEN 'Voice message'
      WHEN 'sticker'  THEN 'Sticker'
      WHEN 'document' THEN 'Document' || COALESCE(': ' || NULLIF(m #>> '{document,filename}', ''), '')
      WHEN 'location' THEN 'Location' || COALESCE(': ' || NULLIF(m #>> '{location,name}', ''), '')
      WHEN 'contacts' THEN 'Contact card'
      WHEN 'reaction' THEN 'Reaction ' || COALESCE(m #>> '{reaction,emoji}', '')
      ELSE 'Message (' || COALESCE(m ->> 'type', 'unknown') || ')' END), 4096)
$$;
REVOKE ALL ON FUNCTION public._whatsapp_body(JSONB) FROM PUBLIC, anon, authenticated;

-- Can the signed-in viewer send through the server (owner; staff with WhatsApp or Invoices → edit,
-- only via the site's own server so the token never reaches a browser)?
CREATE OR REPLACE FUNCTION public._whatsapp_may_send() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_full_admin()
      OR ((public.staff_can('whatsapp', 'edit') OR public.staff_can('invoices', 'edit')) AND public._trusted_route_call())
$$;
REVOKE ALL ON FUNCTION public._whatsapp_may_send() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The owner's settings
-- ─────────────────────────────────────────────────────────────────────────────
-- What the admin shows: everything but the token and the app secret (only whether they are set).
-- The verify token (to paste into Meta) is shown to the owner only.
CREATE OR REPLACE FUNCTION public.admin_whatsapp_status()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s       public.whatsapp_settings;
  v_owner BOOLEAN := public.is_full_admin();
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see the WhatsApp settings.';
  END IF;
  SELECT * INTO s FROM public.whatsapp_settings WHERE id;
  RETURN jsonb_build_object(
    'configured',                s.phone_number_id IS NOT NULL AND s.access_token IS NOT NULL,
    'phone_number_id',           s.phone_number_id,
    'business_account_id',       s.business_account_id,
    'token_set',                 s.access_token IS NOT NULL,
    'app_secret_set',            s.app_secret IS NOT NULL,
    'verify_token',              CASE WHEN v_owner THEN s.verify_token END,
    'api_version',               s.api_version,
    'display_phone',             s.display_phone,
    'verified_name',             s.verified_name,
    'ai_auto_reply',             s.ai_auto_reply,
    'ai_pause_hours',            s.ai_pause_hours,
    'invoice_template',          s.invoice_template,
    'invoice_template_language', s.invoice_template_language,
    'connected_at',              s.connected_at,
    'last_error',                s.last_error,
    'last_webhook_at',           s.last_webhook_at,
    'is_owner',                  v_owner);
END $$;
REVOKE ALL ON FUNCTION public.admin_whatsapp_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_whatsapp_status() TO authenticated;

-- OWNER ONLY. Keys present change; the token and the app secret: a non-empty string replaces,
-- null clears, absent keeps. regenerate_verify_token: true makes a new one (paste it into Meta
-- again). Changing the number or the token clears the "connected" mark until it is tested again.
CREATE OR REPLACE FUNCTION public.admin_save_whatsapp_settings(p_settings JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_keys CONSTANT TEXT[] := ARRAY['phone_number_id', 'business_account_id', 'access_token', 'app_secret', 'api_version',
    'ai_auto_reply', 'ai_pause_hours', 'invoice_template', 'invoice_template_language', 'regenerate_verify_token'];
  c_e    CONSTANT TEXT := 'invalid_whatsapp';
  s      public.whatsapp_settings;
  v_key  TEXT;
  v_text TEXT;
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only the owner can change the WhatsApp keys.';
  END IF;
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:The settings must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_settings) LOOP
    IF NOT (v_key = ANY (c_keys)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_whatsapp:The field “%s” can''t be saved here.', left(v_key, 40));
    END IF;
  END LOOP;
  SELECT * INTO s FROM public.whatsapp_settings WHERE id FOR UPDATE;

  IF p_settings ? 'phone_number_id' THEN
    v_text := NULLIF(regexp_replace(COALESCE(p_settings ->> 'phone_number_id', ''), '\s', '', 'g'), '');
    IF v_text IS NOT NULL AND v_text !~ '^[0-9]{5,30}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:The Phone number ID is the long number Meta shows under WhatsApp → API setup (digits only).';
    END IF;
    IF v_text IS DISTINCT FROM s.phone_number_id THEN s.connected_at := NULL; s.display_phone := NULL; s.verified_name := NULL; END IF;
    s.phone_number_id := v_text;
  END IF;
  IF p_settings ? 'business_account_id' THEN
    v_text := NULLIF(regexp_replace(COALESCE(p_settings ->> 'business_account_id', ''), '\s', '', 'g'), '');
    IF v_text IS NOT NULL AND v_text !~ '^[0-9]{5,30}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:The WhatsApp Business Account ID is digits only.';
    END IF;
    s.business_account_id := v_text;
  END IF;
  IF p_settings ? 'access_token' THEN
    IF jsonb_typeof(p_settings -> 'access_token') = 'null' THEN
      s.access_token := NULL; s.connected_at := NULL;
    ELSE
      v_text := btrim(COALESCE(p_settings ->> 'access_token', ''));
      IF v_text <> '' THEN
        IF char_length(v_text) NOT BETWEEN 20 AND 2000 OR v_text ~ '\s' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:That doesn''t look like an access token — copy the whole token Meta shows (no spaces).';
        END IF;
        IF v_text IS DISTINCT FROM s.access_token THEN s.connected_at := NULL; END IF;
        s.access_token := v_text;
      END IF;
    END IF;
  END IF;
  IF p_settings ? 'app_secret' THEN
    IF jsonb_typeof(p_settings -> 'app_secret') = 'null' THEN
      s.app_secret := NULL;
    ELSE
      v_text := btrim(COALESCE(p_settings ->> 'app_secret', ''));
      IF v_text <> '' THEN
        IF char_length(v_text) NOT BETWEEN 8 AND 200 OR v_text ~ '\s' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:That doesn''t look like an app secret — copy it from Meta: App settings → Basic → App secret.';
        END IF;
        s.app_secret := v_text;
      END IF;
    END IF;
  END IF;
  IF p_settings ? 'api_version' THEN
    v_text := btrim(COALESCE(p_settings ->> 'api_version', ''));
    IF v_text !~ '^v[0-9]{1,3}\.[0-9]{1,2}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:The API version looks like v27.0.';
    END IF;
    s.api_version := v_text;
  END IF;
  IF p_settings ? 'ai_auto_reply' THEN
    s.ai_auto_reply := COALESCE(public._admin_json_bool(c_e, p_settings -> 'ai_auto_reply', 'AI replies'), FALSE);
  END IF;
  IF p_settings ? 'ai_pause_hours' THEN
    s.ai_pause_hours := COALESCE(public._admin_json_int(c_e, p_settings -> 'ai_pause_hours', 'The AI pause (hours)', 0, 720), 12);
  END IF;
  IF p_settings ? 'invoice_template' THEN
    v_text := NULLIF(lower(btrim(COALESCE(p_settings ->> 'invoice_template', ''))), '');
    IF v_text IS NOT NULL AND (char_length(v_text) > 512 OR v_text !~ '^[a-z0-9_]+$') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:A template name has lower-case letters, numbers and underscores only (e.g. invoice_pdf).';
    END IF;
    s.invoice_template := v_text;
  END IF;
  IF p_settings ? 'invoice_template_language' THEN
    v_text := btrim(COALESCE(p_settings ->> 'invoice_template_language', ''));
    IF v_text !~ '^[a-z]{2,3}(_[A-Z]{2})?$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:The template language is a code like en or en_US.';
    END IF;
    s.invoice_template_language := v_text;
  END IF;
  IF COALESCE(public._admin_json_bool(c_e, p_settings -> 'regenerate_verify_token', 'New verify token'), FALSE) THEN
    s.verify_token := replace(gen_random_uuid()::text, '-', '');
  END IF;

  UPDATE public.whatsapp_settings
     SET phone_number_id = s.phone_number_id, business_account_id = s.business_account_id,
         access_token = s.access_token, app_secret = s.app_secret, verify_token = s.verify_token,
         api_version = s.api_version, ai_auto_reply = s.ai_auto_reply, ai_pause_hours = s.ai_pause_hours,
         invoice_template = s.invoice_template, invoice_template_language = s.invoice_template_language,
         connected_at = s.connected_at, display_phone = s.display_phone, verified_name = s.verified_name,
         updated_at = now(), updated_by = auth.uid()
   WHERE id;
  RETURN public.admin_whatsapp_status();
END $$;
REVOKE ALL ON FUNCTION public.admin_save_whatsapp_settings(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_whatsapp_settings(JSONB) TO authenticated;

-- OWNER ONLY. What "Test connection" learned from Meta: {ok: true, display_phone, verified_name} or
-- {ok: false, error}.
CREATE OR REPLACE FUNCTION public.admin_whatsapp_connection_result(p_result JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only the owner can test the WhatsApp connection.';
  END IF;
  IF COALESCE((p_result ->> 'ok')::BOOLEAN, FALSE) THEN
    UPDATE public.whatsapp_settings
       SET connected_at = now(), last_error = NULL,
           display_phone = left(NULLIF(btrim(p_result ->> 'display_phone'), ''), 40),
           verified_name = left(NULLIF(btrim(p_result ->> 'verified_name'), ''), 200)
     WHERE id;
  ELSE
    UPDATE public.whatsapp_settings
       SET connected_at = NULL, last_error = left(COALESCE(NULLIF(btrim(p_result ->> 'error'), ''), 'The connection test failed.'), 500)
     WHERE id;
  END IF;
  RETURN public.admin_whatsapp_status();
END $$;
REVOKE ALL ON FUNCTION public.admin_whatsapp_connection_result(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_whatsapp_connection_result(JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Sending (the site's server, for a signed-in owner or staff member)
-- ─────────────────────────────────────────────────────────────────────────────
-- The token and where to send — only to the site's own server (see _whatsapp_may_send).
CREATE OR REPLACE FUNCTION public.whatsapp_send_credentials()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.whatsapp_settings;
BEGIN
  IF auth.uid() IS NULL OR NOT public._whatsapp_may_send() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t send WhatsApp messages.';
  END IF;
  SELECT * INTO s FROM public.whatsapp_settings WHERE id;
  IF s.phone_number_id IS NULL OR s.access_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'not_configured:WhatsApp isn''t connected yet — the owner adds the keys in admin → WhatsApp.';
  END IF;
  RETURN jsonb_build_object('access_token', s.access_token, 'phone_number_id', s.phone_number_id, 'api_version', s.api_version,
                            'invoice_template', s.invoice_template, 'invoice_template_language', s.invoice_template_language);
END $$;
REVOKE ALL ON FUNCTION public.whatsapp_send_credentials() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_send_credentials() TO authenticated;

-- After a send (or a refused one): the message goes into the customer's chat.
-- p: {to (a phone or wa_id), name?, wa_message_id?, kind, body?, media_filename?, media_mime?,
--     invoice_id?, status: sent | failed, error?} → {conversation_id, message_id}
CREATE OR REPLACE FUNCTION public.admin_whatsapp_record_outbound(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_wa     TEXT;
  v_status TEXT := lower(COALESCE(p ->> 'status', 'sent'));
  c        public.whatsapp_conversations;
  v_id     BIGINT;
  v_body   TEXT := left(NULLIF(btrim(COALESCE(p ->> 'body', '')), ''), 4096);
BEGIN
  IF auth.uid() IS NULL OR NOT public._whatsapp_may_send() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t send WhatsApp messages.';
  END IF;
  v_wa := public._whatsapp_wa_id(p ->> 'to');
  IF v_wa IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:That isn''t a phone number WhatsApp can use.';
  END IF;
  IF v_status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_whatsapp:The status is sent or failed.';
  END IF;
  c := public._whatsapp_conversation(v_wa, p ->> 'name');
  INSERT INTO public.whatsapp_messages (conversation_id, direction, wa_message_id, kind, body, media_filename, media_mime,
                                        status, error, sent_by, invoice_id)
  VALUES (c.id, 'out', NULLIF(btrim(COALESCE(p ->> 'wa_message_id', '')), ''),
          COALESCE(NULLIF(lower(p ->> 'kind'), ''), 'text'), v_body,
          left(NULLIF(btrim(COALESCE(p ->> 'media_filename', '')), ''), 240), left(NULLIF(btrim(COALESCE(p ->> 'media_mime', '')), ''), 120),
          v_status, left(NULLIF(btrim(COALESCE(p ->> 'error', '')), ''), 500),
          (SELECT cu.id FROM public.customers cu WHERE cu.id = auth.uid()),
          (SELECT i.id FROM public.invoices i WHERE i.id = public._admin_json_int('invalid_whatsapp', p -> 'invoice_id', 'The invoice', 1, 2147483647)))
  ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_status = 'sent' THEN
    UPDATE public.whatsapp_conversations
       SET last_message_at = now(), last_human_reply_at = now(), unread_count = 0,
           last_preview = left(COALESCE(v_body, CASE WHEN p ->> 'kind' = 'document' THEN 'Document' ELSE 'Message' END), 200)
     WHERE id = c.id;
  END IF;
  RETURN jsonb_build_object('conversation_id', c.id, 'message_id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_whatsapp_record_outbound(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_whatsapp_record_outbound(JSONB) TO authenticated;

-- A chat's own switches: read (unread → 0, staff with WhatsApp → view) and, for WhatsApp → edit,
-- ai_enabled and name. p: {read?, ai_enabled?, name?}
CREATE OR REPLACE FUNCTION public.admin_whatsapp_update_conversation(p_conversation_id INT, p JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c public.whatsapp_conversations;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t open WhatsApp chats.';
  END IF;
  IF (p ? 'ai_enabled' OR p ? 'name') AND NOT (public.is_full_admin() OR public.staff_can('whatsapp', 'edit')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can only read WhatsApp chats.';
  END IF;
  SELECT * INTO c FROM public.whatsapp_conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'conversation_not_found:That chat no longer exists.';
  END IF;
  UPDATE public.whatsapp_conversations
     SET unread_count = CASE WHEN COALESCE((p ->> 'read')::BOOLEAN, FALSE) THEN 0 ELSE unread_count END,
         ai_enabled   = CASE WHEN p ? 'ai_enabled' THEN COALESCE(public._admin_json_bool('invalid_whatsapp', p -> 'ai_enabled', 'AI replies'), ai_enabled) ELSE ai_enabled END,
         name         = CASE WHEN p ? 'name' THEN NULLIF(left(btrim(COALESCE(p ->> 'name', '')), 120), '') ELSE name END
   WHERE id = c.id
  RETURNING * INTO c;
  RETURN to_jsonb(c);
END $$;
REVOKE ALL ON FUNCTION public.admin_whatsapp_update_conversation(INT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_whatsapp_update_conversation(INT, JSONB) TO authenticated;

-- Can a free-form message go to this number now? Meta's 24-hour window runs from the customer's
-- last message. {wa_id, valid, open, last_inbound_at, conversation_id} — for the invoice "Send on
-- WhatsApp" dialog and the server's send routes (outside the window only a template can be sent).
CREATE OR REPLACE FUNCTION public.admin_whatsapp_window(p_to TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_wa TEXT;
  c    public.whatsapp_conversations;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t send WhatsApp messages.';
  END IF;
  v_wa := public._whatsapp_wa_id(left(p_to, 60));
  IF v_wa IS NULL OR v_wa !~ '^[0-9]{6,20}$' THEN
    RETURN jsonb_build_object('wa_id', NULL, 'valid', FALSE, 'open', FALSE, 'last_inbound_at', NULL, 'conversation_id', NULL);
  END IF;
  SELECT * INTO c FROM public.whatsapp_conversations WHERE wa_id = v_wa;
  RETURN jsonb_build_object('wa_id', v_wa, 'valid', TRUE,
                            'open', COALESCE(c.last_inbound_at > now() - interval '24 hours', FALSE),
                            'last_inbound_at', c.last_inbound_at, 'conversation_id', c.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_whatsapp_window(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_whatsapp_window(TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Meta's webhook (/api/whatsapp/webhook — no signed-in user; Meta's signature is the proof)
-- ─────────────────────────────────────────────────────────────────────────────
-- Meta's one-time "verify" call: TRUE when the token matches ours.
CREATE OR REPLACE FUNCTION public.whatsapp_verify_webhook(p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT verify_token INTO v_token FROM public.whatsapp_settings WHERE id;
  IF v_token IS NULL OR p_token IS NULL OR char_length(p_token) > 200 THEN
    RETURN FALSE;
  END IF;
  RETURN digest(p_token, 'sha256') = digest(v_token, 'sha256');
END $$;
REVOKE ALL ON FUNCTION public.whatsapp_verify_webhook(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_verify_webhook(TEXT) TO anon, authenticated;

-- Messages and delivery statuses from Meta. p_body = the RAW request body, p_signature = its
-- X-Hub-Signature-256 header. Stores new messages once (Meta may send one twice), moves outgoing
-- messages' status forward (never back), and answers
--   {ok, received, statuses, ai: [{conversation_id, wa_id, name, text, history: [{direction, body}]}],
--    credentials: {access_token, phone_number_id, api_version} — only when the AI should answer}
-- The AI answers a new TEXT message when AI replies are on, the chat allows it, and no person has
-- replied in that chat within ai_pause_hours.
CREATE OR REPLACE FUNCTION public.whatsapp_receive(p_body TEXT, p_signature TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s          public.whatsapp_settings;
  v_payload  JSONB;
  e          JSONB;
  ch         JSONB;
  m          JSONB;
  st         JSONB;
  v_names    JSONB;
  c          public.whatsapp_conversations;
  v_id       BIGINT;
  v_at       TIMESTAMPTZ;
  v_received INT := 0;
  v_statuses INT := 0;
  v_ai       JSONB := '[]'::jsonb;
  v_rank     JSONB := '{"sent": 1, "delivered": 2, "read": 3, "failed": 4}'::jsonb;
BEGIN
  IF NOT public._route_or_budget('whatsapp_receive', 600, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  SELECT * INTO s FROM public.whatsapp_settings WHERE id;
  IF s.app_secret IS NULL THEN
    RAISE EXCEPTION 'not_configured';
  END IF;
  IF octet_length(COALESCE(p_body, '')) > 1048576 OR NOT public._whatsapp_signed(p_body, p_signature) THEN
    RAISE EXCEPTION 'bad_signature';
  END IF;
  BEGIN
    v_payload := p_body::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_payload';
  END;
  IF jsonb_typeof(v_payload -> 'entry') <> 'array' THEN
    RETURN jsonb_build_object('ok', TRUE, 'received', 0, 'statuses', 0, 'ai', '[]'::jsonb);
  END IF;

  FOR e IN SELECT x FROM jsonb_array_elements(v_payload -> 'entry') x LOOP
    CONTINUE WHEN jsonb_typeof(e -> 'changes') <> 'array';
    FOR ch IN SELECT x -> 'value' FROM jsonb_array_elements(e -> 'changes') x WHERE x ->> 'field' = 'messages' LOOP
      -- only our number (a Meta app can serve several)
      CONTINUE WHEN s.phone_number_id IS NOT NULL AND ch #>> '{metadata,phone_number_id}' IS DISTINCT FROM s.phone_number_id;
      SELECT COALESCE(jsonb_object_agg(x ->> 'wa_id', x #>> '{profile,name}'), '{}'::jsonb) INTO v_names
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ch -> 'contacts') = 'array' THEN ch -> 'contacts' ELSE '[]'::jsonb END) x
       WHERE x ->> 'wa_id' IS NOT NULL;

      FOR m IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ch -> 'messages') = 'array' THEN ch -> 'messages' ELSE '[]'::jsonb END) x LOOP
        CONTINUE WHEN COALESCE(m ->> 'from', '') !~ '^[0-9]{6,20}$' OR NULLIF(m ->> 'id', '') IS NULL;
        v_at := CASE WHEN COALESCE(m ->> 'timestamp', '') ~ '^[0-9]{9,11}$' THEN to_timestamp((m ->> 'timestamp')::BIGINT) ELSE now() END;
        c := public._whatsapp_conversation(m ->> 'from', v_names ->> (m ->> 'from'));
        INSERT INTO public.whatsapp_messages (conversation_id, direction, wa_message_id, kind, body, media_id, media_filename, media_mime, status, created_at)
        VALUES (c.id, 'in', left(m ->> 'id', 200),
                CASE WHEN COALESCE(m ->> 'type', '') ~ '^[a-z_]{1,20}$' THEN m ->> 'type' ELSE 'other' END,
                public._whatsapp_body(m),
                left(COALESCE(m #>> '{image,id}', m #>> '{document,id}', m #>> '{audio,id}', m #>> '{video,id}', m #>> '{sticker,id}'), 200),
                left(m #>> '{document,filename}', 240),
                left(COALESCE(m #>> '{image,mime_type}', m #>> '{document,mime_type}', m #>> '{audio,mime_type}', m #>> '{video,mime_type}'), 120),
                'received', LEAST(v_at, now()))
        ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
        RETURNING id INTO v_id;
        CONTINUE WHEN v_id IS NULL;                     -- already had it (Meta retried)
        v_received := v_received + 1;
        UPDATE public.whatsapp_conversations
           SET last_message_at = GREATEST(COALESCE(last_message_at, v_at), v_at),
               last_inbound_at = GREATEST(COALESCE(last_inbound_at, v_at), v_at),
               unread_count = unread_count + 1,
               last_preview = left(public._whatsapp_body(m), 200),
               name = COALESCE(name, NULLIF(left(btrim(COALESCE(v_names ->> (m ->> 'from'), '')), 120), ''))
         WHERE id = c.id
        RETURNING * INTO c;
        IF s.ai_auto_reply AND c.ai_enabled AND m ->> 'type' = 'text'
           AND (c.last_human_reply_at IS NULL OR c.last_human_reply_at < now() - make_interval(hours => s.ai_pause_hours)) THEN
          v_ai := v_ai || jsonb_build_array(jsonb_build_object(
            'conversation_id', c.id, 'wa_id', c.wa_id, 'name', c.name, 'text', m #>> '{text,body}',
            'history', (SELECT COALESCE(jsonb_agg(jsonb_build_object('direction', h.direction, 'body', h.body) ORDER BY h.created_at, h.id), '[]'::jsonb)
                          FROM (SELECT * FROM public.whatsapp_messages wm
                                 WHERE wm.conversation_id = c.id AND wm.id <> v_id AND wm.body IS NOT NULL AND wm.status <> 'failed'
                                 ORDER BY wm.created_at DESC, wm.id DESC LIMIT 12) h)));
        END IF;
      END LOOP;

      FOR st IN SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ch -> 'statuses') = 'array' THEN ch -> 'statuses' ELSE '[]'::jsonb END) x LOOP
        CONTINUE WHEN NOT (v_rank ? COALESCE(st ->> 'status', ''));
        UPDATE public.whatsapp_messages wm
           SET status = st ->> 'status',
               error  = CASE WHEN st ->> 'status' = 'failed'
                             THEN left(COALESCE(st #>> '{errors,0,error_data,details}', st #>> '{errors,0,message}', st #>> '{errors,0,title}', 'WhatsApp could not deliver it.'), 500)
                             ELSE wm.error END
         WHERE wm.wa_message_id = st ->> 'id' AND wm.direction = 'out'
           AND (v_rank ->> (st ->> 'status'))::INT > COALESCE((v_rank ->> wm.status)::INT, 0);
        IF FOUND THEN v_statuses := v_statuses + 1; END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  UPDATE public.whatsapp_settings SET last_webhook_at = now() WHERE id;
  RETURN jsonb_build_object('ok', TRUE, 'received', v_received, 'statuses', v_statuses, 'ai', v_ai)
      || CASE WHEN jsonb_array_length(v_ai) > 0 AND s.access_token IS NOT NULL AND s.phone_number_id IS NOT NULL
              THEN jsonb_build_object('credentials', jsonb_build_object('access_token', s.access_token,
                                        'phone_number_id', s.phone_number_id, 'api_version', s.api_version))
              ELSE '{}'::jsonb END;
END $$;
REVOKE ALL ON FUNCTION public.whatsapp_receive(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_receive(TEXT, TEXT) TO anon, authenticated;

-- The AI's answer to a webhook message goes into the chat. The same signed body is the proof.
-- p: {conversation_id, wa_message_id?, body, status: sent | failed, error?}
CREATE OR REPLACE FUNCTION public.whatsapp_record_ai_reply(p_body TEXT, p_signature TEXT, p JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_conv   INT;
  v_status TEXT := lower(COALESCE(p ->> 'status', 'sent'));
  v_text   TEXT := left(NULLIF(btrim(COALESCE(p ->> 'body', '')), ''), 4096);
  v_id     BIGINT;
BEGIN
  IF NOT public._route_or_budget('whatsapp_receive', 600, 60) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF NOT public._whatsapp_signed(p_body, p_signature) THEN
    RAISE EXCEPTION 'bad_signature';
  END IF;
  SELECT id INTO v_conv FROM public.whatsapp_conversations WHERE id = (p ->> 'conversation_id')::INT;
  IF NOT FOUND OR v_status NOT IN ('sent', 'failed') OR v_text IS NULL THEN
    RAISE EXCEPTION 'invalid_payload';
  END IF;
  INSERT INTO public.whatsapp_messages (conversation_id, direction, wa_message_id, kind, body, status, error, sent_by_ai)
  VALUES (v_conv, 'out', NULLIF(btrim(COALESCE(p ->> 'wa_message_id', '')), ''), 'text', v_text, v_status,
          left(NULLIF(btrim(COALESCE(p ->> 'error', '')), ''), 500), TRUE)
  ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_status = 'sent' THEN
    UPDATE public.whatsapp_conversations SET last_message_at = now(), last_preview = left(v_text, 200) WHERE id = v_conv;
  END IF;
  RETURN jsonb_build_object('message_id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.whatsapp_record_ai_reply(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_record_ai_reply(TEXT, TEXT, JSONB) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Staff map
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '54';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration) VALUES
  ('table', 'whatsapp_conversations',             'whatsapp', 'view', 'admin', '54'),
  ('table', 'whatsapp_messages',                  'whatsapp', 'view', 'admin', '54'),
  ('table', 'whatsapp_messages',                  'invoices', 'view', 'admin', '54'),
  ('rpc',   'admin_whatsapp_status',              'whatsapp', 'view', 'view',  '54'),
  ('rpc',   'admin_whatsapp_status',              'invoices', 'view', 'view',  '54'),
  ('rpc',   'whatsapp_send_credentials',          'whatsapp', 'view', 'edit',  '54'),
  ('rpc',   'whatsapp_send_credentials',          'invoices', 'view', 'edit',  '54'),
  ('rpc',   'admin_whatsapp_record_outbound',     'whatsapp', 'view', 'edit',  '54'),
  ('rpc',   'admin_whatsapp_record_outbound',     'invoices', 'view', 'edit',  '54'),
  ('rpc',   'admin_whatsapp_update_conversation', 'whatsapp', 'view', 'view',  '54'),
  ('rpc',   'admin_whatsapp_window',              'whatsapp', 'view', 'view',  '54'),
  ('rpc',   'admin_whatsapp_window',              'invoices', 'view', 'edit',  '54');

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 54_whatsapp
--   Run after 01–53 (re-run 54 after any re-run of 39). Nothing changes until the owner adds the
--   keys in admin → WhatsApp (docs/WHATSAPP_SETUP.md walks through creating the Meta app).
--   Verification:
--     SELECT phone_number_id, access_token IS NOT NULL AS token_set, app_secret IS NOT NULL AS secret_set,
--            connected_at, last_webhook_at FROM public.whatsapp_settings;
--     SELECT has_table_privilege('authenticated', 'public.whatsapp_settings', 'SELECT');   -- false (sealed)
--     SELECT wa_id, name, last_message_at, unread_count FROM public.whatsapp_conversations ORDER BY last_message_at DESC LIMIT 10;
-- ═════════════════════════════════════════════════════════════════════════════
