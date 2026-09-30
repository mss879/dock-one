"use client";

import { Hammer } from "lucide-react";
import { getAdminTab, type AdminTabKey } from "./registry";
import { EmptyState, SectionCard, TabHeader } from "./ui";

/**
 * Placeholder body for a tab whose owner hasn't shipped it yet. Honest: it says the section is
 * being built and what it will do — no sample data, no dead buttons (blueprint §11.2: never ship
 * a form that saves nothing).
 */
export function TabStub({ tab }: { tab: AdminTabKey }) {
  const def = getAdminTab(tab);
  return (
    <>
      <TabHeader eyebrow={def.group} title={def.label} description={def.summary} />
      <SectionCard>
        <EmptyState
          icon={<Hammer aria-hidden className="size-5" />}
          title="This section is being built"
          description="It will appear here as soon as it's ready. Nothing on this screen changes your store yet."
        />
      </SectionCard>
    </>
  );
}
