-- ═════════════════════════════════════════════════════════════════════════════
-- 15_content_pages.sql — Dock One Solutions
--
-- PURPOSE      Owner-written content (blueprint §7.3 cms_pages/blog_posts, §7.4, §9.1, Appendix A 12):
--                cms_pages   privacy, terms, returns and any other page the owner publishes
--                            (/privacy, /terms, /returns, /pages/<slug>), with footer placement
--                            (show_in_footer + footer_group customer_service | company | legal)
--                blog_posts  /blogs and /blogs/<slug> (Article JSON-LD)
--              Public read ONLY where is_published (the reference store forgot this); admins hold
--              all four verbs. Content is stored as authored (Markdown-lite / HTML) and is ALWAYS
--              run through the allowlist sanitiser on render (blueprint §6.6) — never trusted here.
-- DEPENDS ON   01_foundation (touch_updated_at), 02_customers_and_auth (is_admin()).
-- ENABLES      src/lib/cms.ts + the content routes and admin Content tab (WP-G), footer link
--              columns (WP-B getFooterLinks), sitemap (WP-A), seed 33 (privacy page).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.cms_pages (
  id              SERIAL PRIMARY KEY,
  slug            TEXT NOT NULL,                        -- privacy | terms | returns | <any> → /pages/<slug>
  title           TEXT NOT NULL,
  summary         TEXT,                                 -- lead paragraph / meta description fallback
  content         TEXT NOT NULL,                        -- as authored; sanitised on render
  cover_image     TEXT,                                 -- /path or https://
  seo_title       TEXT,
  seo_description TEXT,
  is_published    BOOLEAN NOT NULL DEFAULT FALSE,
  show_in_footer  BOOLEAN NOT NULL DEFAULT FALSE,
  footer_group    TEXT,                                 -- customer_service | company | legal
  sort_order      INT NOT NULL DEFAULT 100,             -- order inside its footer column
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cms_pages_slug_key         UNIQUE (slug),
  CONSTRAINT cms_pages_slug_format      CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$' AND char_length(slug) <= 120),
  CONSTRAINT cms_pages_footer_group_valid CHECK (footer_group IS NULL OR footer_group IN ('customer_service', 'company', 'legal')),
  CONSTRAINT cms_pages_footer_needs_group CHECK (NOT show_in_footer OR footer_group IS NOT NULL),
  CONSTRAINT cms_pages_text_lengths     CHECK (
        char_length(btrim(title)) BETWEEN 1 AND 200
    AND (summary         IS NULL OR char_length(summary)         <= 500)
    AND char_length(content) <= 200000
    AND (cover_image     IS NULL OR (char_length(cover_image) <= 1000 AND cover_image ~ '^(/[^/\\\s][^\\\s]*|https://[^\\\s]+)$'))
    AND (seo_title       IS NULL OR char_length(seo_title)       <= 120)
    AND (seo_description IS NULL OR char_length(seo_description) <= 320))
);
CREATE INDEX IF NOT EXISTS cms_pages_footer_idx ON public.cms_pages (footer_group, sort_order, id)
  WHERE show_in_footer AND is_published;

CREATE TABLE IF NOT EXISTS public.blog_posts (
  id              SERIAL PRIMARY KEY,
  slug            TEXT NOT NULL,                        -- /blogs/<slug>
  title           TEXT NOT NULL,
  summary         TEXT,
  content         TEXT NOT NULL,                        -- as authored; sanitised on render
  cover_image     TEXT,
  author          TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  published_at    TIMESTAMPTZ,                          -- set to now() when first published without a date
  is_published    BOOLEAN NOT NULL DEFAULT FALSE,
  seo_title       TEXT,
  seo_description TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blog_posts_slug_key     UNIQUE (slug),
  CONSTRAINT blog_posts_slug_format  CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$' AND char_length(slug) <= 120),
  CONSTRAINT blog_posts_tags_valid   CHECK (
        cardinality(tags) <= 20
    AND array_position(tags, NULL) IS NULL
    AND NOT ('' = ANY (tags))
    AND NOT jsonb_path_exists(to_jsonb(tags), '$[*] ? (@ like_regex "^.{41}" flag "s")')),
  CONSTRAINT blog_posts_text_lengths CHECK (
        char_length(btrim(title)) BETWEEN 1 AND 200
    AND (summary         IS NULL OR char_length(summary)         <= 500)
    AND char_length(content) <= 200000
    AND (cover_image     IS NULL OR (char_length(cover_image) <= 1000 AND cover_image ~ '^(/[^/\\\s][^\\\s]*|https://[^\\\s]+)$'))
    AND (author          IS NULL OR char_length(author)          <= 120)
    AND (seo_title       IS NULL OR char_length(seo_title)       <= 120)
    AND (seo_description IS NULL OR char_length(seo_description) <= 320))
);
CREATE INDEX IF NOT EXISTS blog_posts_published_idx ON public.blog_posts (published_at DESC, id DESC) WHERE is_published;

DROP TRIGGER IF EXISTS cms_pages_touch ON public.cms_pages;
CREATE TRIGGER cms_pages_touch BEFORE UPDATE ON public.cms_pages
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS blog_posts_touch ON public.blog_posts;
CREATE TRIGGER blog_posts_touch BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- A post published without a date gets "now" (lists sort by published_at); an explicit date is kept,
-- and unpublishing keeps it (re-publishing does not move the post to the top).
CREATE OR REPLACE FUNCTION public.blog_posts_publish_date() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.is_published AND NEW.published_at IS NULL THEN
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.blog_posts_publish_date() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS blog_posts_10_publish_date ON public.blog_posts;
CREATE TRIGGER blog_posts_10_publish_date BEFORE INSERT OR UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.blog_posts_publish_date();

-- RLS: the public reads PUBLISHED rows only; admins everything. No anonymous writes.
ALTER TABLE public.cms_pages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.cms_pages, public.blog_posts FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.cms_pages, public.blog_posts FROM authenticated;
REVOKE ALL ON SEQUENCE public.cms_pages_id_seq, public.blog_posts_id_seq FROM anon;

DROP POLICY IF EXISTS cms_pages_public_read ON public.cms_pages;
CREATE POLICY cms_pages_public_read ON public.cms_pages
  FOR SELECT TO anon, authenticated USING (is_published);
DROP POLICY IF EXISTS cms_pages_admin_all ON public.cms_pages;
CREATE POLICY cms_pages_admin_all ON public.cms_pages
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS blog_posts_public_read ON public.blog_posts;
CREATE POLICY blog_posts_public_read ON public.blog_posts
  FOR SELECT TO anon, authenticated USING (is_published);
DROP POLICY IF EXISTS blog_posts_admin_all ON public.blog_posts;
CREATE POLICY blog_posts_admin_all ON public.blog_posts
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 15_content_pages
--   No secrets. Pages and posts appear on the storefront only while is_published; the footer lists
--   published pages with show_in_footer, grouped by footer_group. Write the owner's own pages
--   (terms, returns, delivery, warranty…) in the admin Content tab, then revalidate the `content`
--   tag (the tab does this after a confirmed save). Seed 33 adds the privacy page template.
--   Verification:
--     SELECT slug, is_published, show_in_footer, footer_group FROM public.cms_pages ORDER BY footer_group, sort_order;
--     SELECT slug, is_published, published_at FROM public.blog_posts ORDER BY published_at DESC NULLS LAST;
--     -- live probes (anon key is public): drafts are invisible, writes refused
--     curl -s "$SUPABASE_URL/rest/v1/cms_pages?select=slug&is_published=eq.false" -H "apikey: $ANON"   -- []
--     curl -s -X POST "$SUPABASE_URL/rest/v1/blog_posts" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--          -H "Content-Type: application/json" -d '{"slug":"x","title":"x","content":"x"}'           -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
