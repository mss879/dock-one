-- 52_homepage_it_solutions.test.sql — the IT solutions homepage block: created once with its
-- shape, readable by everyone, never written over or brought back by a re-run.
\ir _helpers.sql

SELECT pg_temp.eq((SELECT data ->> 'title' FROM public.content_blocks WHERE key = 'it_solutions'), 'IT solutions for your business',
                  'the block is created with its title');
SELECT pg_temp.eq((SELECT jsonb_array_length(data -> 'items') FROM public.content_blocks WHERE key = 'it_solutions'), 6, 'six items (the schema allows at most 6)');
SELECT pg_temp.ok((SELECT bool_and(i ? 'title' AND i ? 'text' AND i ? 'href' AND (i ->> 'href') ~ '^/')
                     FROM public.content_blocks b, jsonb_array_elements(b.data -> 'items') i WHERE b.key = 'it_solutions'),
                  'every item has a title, a line and a site link');
SELECT pg_temp.eq((SELECT data -> 'cta' ->> 'href' FROM public.content_blocks WHERE key = 'it_solutions'), '/contact', 'the button goes to the contact page');
SELECT pg_temp.ok((SELECT bool_and(char_length(i ->> 'title') <= 60 AND char_length(i ->> 'text') <= 160)
                     FROM public.content_blocks b, jsonb_array_elements(b.data -> 'items') i WHERE b.key = 'it_solutions')
                  AND (SELECT char_length(data ->> 'body') <= 400 AND char_length(data ->> 'title') <= 80 FROM public.content_blocks WHERE key = 'it_solutions'),
                  'the copy fits the admin schema''s limits');
SELECT pg_temp.ok((SELECT bool_and(EXISTS (SELECT 1 FROM public.categories c WHERE c.id = substring(i ->> 'href' FROM 'category=([a-z0-9-]+)')))
                     FROM public.content_blocks b, jsonb_array_elements(b.data -> 'items') i
                    WHERE b.key = 'it_solutions' AND i ->> 'href' LIKE '/shop?category=%'),
                  'every category it links to exists');

SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.content_blocks WHERE key = 'it_solutions'), 1::bigint, 'the storefront can read it');
SELECT pg_temp.logout();

UPDATE public.content_blocks SET data = jsonb_set(data, '{title}', '"Our IT services"') WHERE key = 'it_solutions';
\ir ../migrations/52_homepage_it_solutions.sql
SELECT pg_temp.eq((SELECT data ->> 'title' FROM public.content_blocks WHERE key = 'it_solutions'), 'Our IT services', 'a re-run keeps the owner''s edit');
DELETE FROM public.content_blocks WHERE key = 'it_solutions';
\ir ../migrations/52_homepage_it_solutions.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.content_blocks WHERE key = 'it_solutions'), 0::bigint, 'a re-run doesn''t bring back a block the owner deleted');
