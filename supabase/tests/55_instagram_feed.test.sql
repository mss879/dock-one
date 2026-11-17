-- 55_instagram_feed.test.sql — the Instagram strip: a sealed settings row, the owner-only token
-- (never read back), the public feed (only switched on and with posts, never the token), refresh
-- storing posts (bad links dropped) and a renewed token, staff limits, and a re-run.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner55@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;

SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.get_instagram_feed(), NULL::jsonb, 'nothing on the homepage at first');
SELECT pg_temp.throws($$SELECT count(*) FROM public.instagram_settings$$, '42501', 'the settings row is sealed');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_instagram_token()$$, '22023', 'no token yet', 'not_configured:%');
SELECT pg_temp.throws($$SELECT public.admin_save_instagram('{"access_token": "short"}')$$, '22023', 'a token must look like one', 'invalid_instagram:%');
SELECT set_config('t.st', public.admin_save_instagram(jsonb_build_object('access_token', 'IGAAtoken' || repeat('y', 60), 'enabled', TRUE))::text, false);
SELECT pg_temp.eq(format('%s|%s', current_setting('t.st')::jsonb ->> 'token_set', current_setting('t.st')::jsonb ->> 'enabled'), 'true|true', 'the owner saves the token and switches it on');
SELECT pg_temp.ok(position('IGAAtoken' IN current_setting('t.st')) = 0, 'the token is never sent back by the status');
SELECT pg_temp.eq(left(public.admin_instagram_token() ->> 'access_token', 9), 'IGAAtoken', 'the owner''s session can fetch with it (the admin''s refresh)');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.get_instagram_feed(), NULL::jsonb, 'switched on but no posts yet: still nothing shown');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_instagram_store(jsonb_build_object('username', 'dock.onesolutions', 'posts', jsonb_build_array(
  jsonb_build_object('id', '1', 'permalink', 'https://www.instagram.com/p/AAA/', 'media_type', 'IMAGE', 'image', 'https://scontent.cdninstagram.com/a.jpg', 'caption', 'New laptops in', 'timestamp', '2026-11-15T10:00:00+0000'),
  jsonb_build_object('id', '2', 'permalink', 'https://evil.example/p/BBB/', 'media_type', 'IMAGE', 'image', 'https://scontent.cdninstagram.com/b.jpg'),
  jsonb_build_object('id', '3', 'permalink', 'https://www.instagram.com/reel/CCC/', 'media_type', 'VIDEO', 'image', 'javascript:alert(1)'))));
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(format('%s|%s|%s', public.get_instagram_feed() ->> 'username', jsonb_array_length(public.get_instagram_feed() -> 'posts'),
                         public.get_instagram_feed() #>> '{posts,0,permalink}'),
                  'dock.onesolutions|1|https://www.instagram.com/p/AAA/', 'the homepage gets the posts — only Instagram links with https pictures');
SELECT pg_temp.ok(position('IGAAtoken' IN public.get_instagram_feed()::text) = 0, 'and never the token');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_instagram_store(jsonb_build_object('access_token', 'IGAArenewed' || repeat('z', 60)));
SELECT pg_temp.eq(left(public.admin_instagram_token() ->> 'access_token', 11), 'IGAArenewed', 'a renewed token replaces the old one');
SELECT public.admin_instagram_store('{"error": "Instagram said the token expired"}');
SELECT pg_temp.eq(format('%s|%s', public.admin_instagram_status() ->> 'last_error', jsonb_array_length(public.admin_instagram_status() -> 'posts')),
                  'Instagram said the token expired|1', 'a failed refresh keeps the posts and notes the error');

-- staff
SELECT set_config('t.hp_edit', public.admin_create_staff('hp55@shop.test', 'Counter2026', 'Editor', '{"homepage": "edit"}') ->> 'user_id', false);
SELECT set_config('t.hp_view', public.admin_create_staff('hv55@shop.test', 'Counter2026', 'Viewer', '{"homepage": "view"}') ->> 'user_id', false);
SELECT pg_temp.login(current_setting('t.hp_view')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_instagram_status');
SELECT pg_temp.eq(public.admin_instagram_status() ->> 'username', 'dock.onesolutions', 'Homepage → view sees the status');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_instagram_token');
SELECT pg_temp.throws($$SELECT public.admin_instagram_token()$$, '42501', 'but not the token', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.hp_edit')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_instagram');
SELECT pg_temp.throws($$SELECT public.admin_save_instagram('{"enabled": false}')$$, '42501', 'staff can''t change the connection', 'not_authorised:%');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_instagram_token');
SELECT pg_temp.eq(left(public.admin_instagram_token() ->> 'access_token', 11), 'IGAArenewed', 'Homepage → edit can refresh (through the site''s server)');
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_instagram('{"access_token": null}');
SELECT pg_temp.eq(format('%s|%s', public.admin_instagram_status() ->> 'token_set', public.admin_instagram_status() ->> 'enabled'), 'false|false',
                  'removing the token disconnects and hides the strip');
SELECT pg_temp.logout();
\ir ../migrations/55_instagram_feed.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.staff_api_map WHERE migration = '55'), 3::bigint, 'a re-run keeps three staff map rows');
