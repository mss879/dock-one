-- ═════════════════════════════════════════════════════════════════════════════
-- 43_image_housekeeping.sql — Dock One Solutions
--
-- PURPOSE      Lets the store owner shrink the images already in storage (admin → Store settings →
--              "Image sizes"). The page re-encodes each heavy image to WebP in the browser,
--              uploads the smaller copy, then calls admin_replace_image_url() so every place that
--              shows the old file shows the new one. Most of the Supabase "cached egress" comes from
--              these files, so smaller files lower it directly.
--   1. admin_image_references() — every storage image URL the site uses, with where it is used.
--   2. admin_replace_image_url(old, new) — swaps one URL for another everywhere: products (main
--      image, gallery, cut-out, description), categories, collections, pages, blog posts, hero
--      slides, promo tiles, homepage blocks, order lines and saved baskets. Returns the number of
--      rows changed.
--              Owner only (is_full_admin): staff never reach either function.
-- DEPENDS ON   04, 07, 13, 15, 16, 27, 39.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_image_references()
RETURNS TABLE (url TEXT, used_in TEXT[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only the store owner can manage image files.';
  END IF;
  RETURN QUERY
  WITH refs (url, label) AS (
    SELECT p.image_url, 'Product: ' || p.name FROM public.products p
    UNION ALL SELECT g.u, 'Product: ' || p.name FROM public.products p CROSS JOIN LATERAL unnest(p.image_urls) AS g (u)
    UNION ALL SELECT p.cutout_url, 'Cut-out: ' || p.name FROM public.products p
    UNION ALL SELECT c.stage_image_url, 'Category: ' || c.name FROM public.categories c
    UNION ALL SELECT c.cover_image, 'Collection: ' || c.title FROM public.collections c
    UNION ALL SELECT m.cover_image, 'Page: ' || m.title FROM public.cms_pages m
    UNION ALL SELECT b.cover_image, 'Blog: ' || b.title FROM public.blog_posts b
    UNION ALL SELECT h.image_url, 'Hero slide ' || h.id FROM public.hero_slides h
    UNION ALL SELECT h.mobile_image_url, 'Hero slide ' || h.id || ' (phone)' FROM public.hero_slides h
    UNION ALL SELECT t.image_url, 'Promo tile ' || t.slot FROM public.promo_tiles t
  )
  SELECT r.url, array_agg(DISTINCT r.label ORDER BY r.label)
    FROM refs r
   WHERE r.url LIKE '%/storage/v1/object/public/%'
   GROUP BY r.url
   ORDER BY r.url;
END $$;
REVOKE ALL ON FUNCTION public.admin_image_references() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_image_references() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_replace_image_url(p_old TEXT, p_new TEXT)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n     INT := 0;
  total INT := 0;
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only the store owner can manage image files.';
  END IF;
  IF p_old IS NULL OR p_new IS NULL OR p_old = p_new
     OR char_length(p_old) > 1000 OR char_length(p_new) > 1000
     OR p_old NOT LIKE 'https://%/storage/v1/object/public/%' OR p_new NOT LIKE 'https://%/storage/v1/object/public/%' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_image_url:Both addresses must be images in this store''s storage.';
  END IF;

  UPDATE public.products
     SET image_url   = CASE WHEN image_url = p_old THEN p_new ELSE image_url END,
         image_urls  = array_replace(image_urls, p_old, p_new),
         cutout_url  = CASE WHEN cutout_url = p_old THEN p_new ELSE cutout_url END,
         description = CASE WHEN strpos(description, p_old) > 0 THEN replace(description, p_old, p_new) ELSE description END
   WHERE image_url = p_old OR p_old = ANY (image_urls) OR cutout_url = p_old OR strpos(coalesce(description, ''), p_old) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  UPDATE public.categories SET stage_image_url = p_new WHERE stage_image_url = p_old;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  UPDATE public.collections SET cover_image = p_new WHERE cover_image = p_old;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  UPDATE public.cms_pages
     SET cover_image = CASE WHEN cover_image = p_old THEN p_new ELSE cover_image END,
         content     = replace(content, p_old, p_new)
   WHERE cover_image = p_old OR strpos(content, p_old) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  UPDATE public.blog_posts
     SET cover_image = CASE WHEN cover_image = p_old THEN p_new ELSE cover_image END,
         content     = replace(content, p_old, p_new)
   WHERE cover_image = p_old OR strpos(content, p_old) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  UPDATE public.hero_slides
     SET image_url        = CASE WHEN image_url = p_old THEN p_new ELSE image_url END,
         mobile_image_url = CASE WHEN mobile_image_url = p_old THEN p_new ELSE mobile_image_url END
   WHERE image_url = p_old OR mobile_image_url = p_old;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  UPDATE public.promo_tiles SET image_url = p_new WHERE image_url = p_old;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  UPDATE public.content_blocks SET data = replace(data::TEXT, p_old, p_new)::JSONB WHERE strpos(data::TEXT, p_old) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  -- Snapshots: the same picture, smaller — so past orders and saved baskets keep showing it.
  PERFORM set_config('app.trusted_write', 'on', true);
  UPDATE public.order_items SET image_url = p_new WHERE image_url = p_old;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  UPDATE public.abandoned_carts SET cart_items = replace(cart_items::TEXT, p_old, p_new)::JSONB WHERE strpos(cart_items::TEXT, p_old) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
  PERFORM set_config('app.trusted_write', 'off', true);

  RETURN total;
END $$;
REVOKE ALL ON FUNCTION public.admin_replace_image_url(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_replace_image_url(TEXT, TEXT) TO authenticated;
