"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { ContentEditor } from "@/components/admin/content/ContentEditor";
import { ContentList } from "@/components/admin/content/ContentList";
import { CONTENT_TABLE, CONTENT_WRITE, storefrontHref, type ContentKind } from "@/components/admin/content/content-admin";
import { getAdminTab } from "@/components/admin/registry";
import { AdminButton, ConfirmDialog, TabHeader, Tabs } from "@/components/admin/ui";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";
import { deleteRows } from "@/lib/admin/write";

/**
 * Admin → Content → Pages & blog (BUILD_SPEC §9 WP-G; blueprint §11.2 "Content: blog_posts,
 * cms_pages — CRUD. HTML sanitised on render"): CMS pages (/privacy, /terms, /returns,
 * /pages/<slug>, footer placement) and blog posts (/blogs). URL-driven:
 *   /admin?tab=content                     pages
 *   /admin?tab=content&kind=posts          blog posts
 *   /admin?tab=content[&kind=posts]&edit=<id|new>   the editor
 * Every write goes through the kit (error + row count) and revalidates the storefront's
 * `content` tag once confirmed.
 */

type DeleteTarget = { kind: ContentKind; id: number; title: string; slug: string; isPublished: boolean };

export default function ContentTab() {
  const tab = getAdminTab("content");
  const kind: ContentKind = useAdminParam("kind") === "posts" ? "posts" : "pages";
  const editParam = useAdminParam("edit");
  const target: number | "new" | null = editParam === "new" ? "new" : editParam && /^\d{1,9}$/.test(editParam) ? Number(editParam) : null;
  const [refreshKey, setRefreshKey] = useState(0);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);

  const noun = kind === "pages" ? "page" : "post";
  const openEditor = (id: number | "new") => setAdminParams({ edit: id });

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => openEditor("new")}>
            {kind === "pages" ? "New page" : "New post"}
          </AdminButton>
        }
      />

      <Tabs
        label="Content type"
        value={kind}
        onChange={(next) => setAdminParams({ kind: next === "posts" ? "posts" : null, edit: null })}
        items={[
          { key: "pages", label: "Pages" },
          { key: "posts", label: "Blog posts" },
        ]}
      >
        <ContentList
          key={kind}
          kind={kind}
          selectedId={typeof target === "number" ? target : null}
          refreshKey={refreshKey}
          onEdit={openEditor}
          onCreate={() => openEditor("new")}
          onRequestDelete={setDeleting}
        />
      </Tabs>

      <ContentEditor
        kind={kind}
        target={target}
        onClose={() => setAdminParams({ edit: null })}
        onSaved={(id, created) => {
          setRefreshKey((n) => n + 1);
          if (created) setAdminParams({ edit: id }, { replace: true });
        }}
        onRequestDelete={setDeleting}
      />

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete “${deleting?.title ?? `this ${noun}`}”?`}
        confirmLabel={deleting?.kind === "posts" ? "Delete post" : "Delete page"}
        requireText={deleting?.isPublished ? deleting.slug : undefined}
        onConfirm={async () => {
          if (!deleting) return { ok: false, message: "Nothing to delete." };
          const result = await deleteRows(CONTENT_TABLE[deleting.kind], { id: deleting.id }, { ...CONTENT_WRITE[deleting.kind], select: "id", expect: 1 });
          if (result.ok) {
            adminToast.success(deleting.kind === "posts" ? "Post deleted" : "Page deleted");
            if (target === deleting.id) setAdminParams({ edit: null });
            setRefreshKey((n) => n + 1);
          }
          return result;
        }}
      >
        <p className="text-[13px] leading-5 text-adm-ink-2">
          {deleting?.isPublished
            ? `It is live at ${storefrontHref(deleting.kind, deleting.slug)}; after deleting, that address answers “not found”${deleting.kind === "pages" ? " and the page leaves the footer" : " and the post leaves the blog list"}. This can't be undone — type the address (slug) to confirm. To take it offline but keep it, unpublish it instead.`
            : "It's a draft, so nothing on the storefront changes. This can't be undone."}
        </p>
      </ConfirmDialog>
    </>
  );
}
