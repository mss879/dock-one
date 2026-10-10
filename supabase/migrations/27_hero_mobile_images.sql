-- ═════════════════════════════════════════════════════════════════════════════
-- 27_hero_mobile_images.sql — Dock One Solutions
--
-- PURPOSE      A second, optional image per hero slide for phones and small tablets.
--              hero_slides.image_url stays the desktop image (wide, text on the left half);
--              hero_slides.mobile_image_url is shown below 1024px, where the slide stacks the text
--              above an image band. NULL = phones get the desktop image, as before.
--              Same rule as image_url: a site path (/images/…) or an https:// address.
-- DEPENDS ON   16_storefront_content (hero_slides).
-- ENABLES      admin → Content → Homepage → hero slide "Mobile image"; Hero.tsx serves the right
--              file per screen size (<picture>, so a phone never downloads the desktop image).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.hero_slides ADD COLUMN IF NOT EXISTS mobile_image_url TEXT;  -- /path or https://; NULL → image_url

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hero_slides_mobile_image_valid') THEN
    ALTER TABLE public.hero_slides ADD CONSTRAINT hero_slides_mobile_image_valid
      CHECK (mobile_image_url IS NULL
             OR (char_length(mobile_image_url) <= 1000 AND mobile_image_url ~ '^(/[^/\\\s][^\\\s]*|https://[^\\\s]+)$'));
  END IF;
END $$;

COMMENT ON COLUMN public.hero_slides.mobile_image_url IS
  'Optional phone/tablet image (below 1024px). NULL = the desktop image_url is used everywhere.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Ops notes
-- ─────────────────────────────────────────────────────────────────────────────
-- Which slides have a mobile image:
--     SELECT id, left(title, 40), image_url, mobile_image_url FROM public.hero_slides ORDER BY position, id;
-- Undo (drops the phone images):
--     ALTER TABLE public.hero_slides DROP CONSTRAINT IF EXISTS hero_slides_mobile_image_valid;
--     ALTER TABLE public.hero_slides DROP COLUMN IF EXISTS mobile_image_url;
