"use client";

import { ExternalLink } from "lucide-react";
import { ContentBlocksPanel } from "@/components/admin/homepage/ContentBlocksPanel";
import { FeaturedCollectionsPanel } from "@/components/admin/homepage/FeaturedCollectionsPanel";
import { FlashSalePanel } from "@/components/admin/homepage/FlashSalePanel";
import { HeroSlidesPanel } from "@/components/admin/homepage/HeroSlidesPanel";
import { NewArrivalsPanel } from "@/components/admin/homepage/NewArrivalsPanel";
import { PromoTilesPanel } from "@/components/admin/homepage/PromoTilesPanel";
import { useContentContext } from "@/components/admin/homepage/shared";
import { getAdminTab } from "@/components/admin/registry";
import { AdminLinkButton, TabHeader, Tabs } from "@/components/admin/ui";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";

/**
 * Admin → Content → Homepage (BUILD_SPEC §9 WP-B, §6): everything the homepage shows that isn't a
 * product — hero slides, promo tiles, the featured collections row, the flash sale (real end time +
 * flash-deal flags), the new-arrivals feature and the content blocks. Every save is confirmed
 * (error + row count) before the storefront's cache tag is refreshed. Deep link:
 * /admin?tab=homepage&section=hero|tiles|collections|flash|new|blocks.
 */

const SECTIONS = ["hero", "tiles", "collections", "flash", "new", "blocks"] as const;
type Section = (typeof SECTIONS)[number];

function isSection(value: string | null): value is Section {
  return value !== null && (SECTIONS as readonly string[]).includes(value);
}

export default function HomepageTab() {
  const tab = getAdminTab("homepage");
  const param = useAdminParam("section");
  const section: Section = isSection(param) ? param : "hero";
  const { ctx } = useContentContext();

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminLinkButton href="/" external variant="ghost" icon={<ExternalLink aria-hidden className="size-3.5" />}>
            View homepage
          </AdminLinkButton>
        }
      />
      <Tabs
        label="Homepage sections"
        value={section}
        onChange={(next) => setAdminParams({ section: next === "hero" ? null : next }, { replace: true })}
        items={[
          { key: "hero", label: "Hero slides" },
          { key: "tiles", label: "Promo tiles" },
          { key: "collections", label: "Collections" },
          { key: "flash", label: "Flash sale" },
          { key: "new", label: "New arrivals" },
          { key: "blocks", label: "Content blocks" },
        ]}
      >
        {section === "hero" && <HeroSlidesPanel ctx={ctx} />}
        {section === "tiles" && <PromoTilesPanel ctx={ctx} />}
        {section === "collections" && <FeaturedCollectionsPanel />}
        {section === "flash" && <FlashSalePanel />}
        {section === "new" && <NewArrivalsPanel />}
        {section === "blocks" && <ContentBlocksPanel ctx={ctx} />}
      </Tabs>
    </>
  );
}
