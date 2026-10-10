"use client";

import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { AdminButton, IconButton, Input, Modal, Toggle, useConfirm } from "@/components/admin/ui";
import { toastResult } from "@/lib/admin/toast";
import { deleteRows, insertRow, updateRows } from "@/lib/admin/write";
import { CATEGORY_WRITE, type ExpenseCategory } from "./model";

/**
 * Expense categories (29): add, rename, reorder, switch off, delete. A category with expenses can't
 * be deleted (the database refuses — the message says to switch it off); switched-off ones stay on
 * their old expenses but aren't offered for new ones.
 */
export function CategoriesModal({
  open,
  categories,
  onClose,
  onChanged,
}: {
  open: boolean;
  categories: ExpenseCategory[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmElement] = useConfirm();
  const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const run = async (work: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    const ok = await work();
    setBusy(false);
    if (ok) onChanged();
  };

  const add = () =>
    run(async () => {
      const clean = name.trim().replace(/\s+/g, " ");
      if (!clean) return false;
      const last = sorted[sorted.length - 1];
      const result = await insertRow("expense_categories", { name: clean, sort_order: (last?.sortOrder ?? 0) + 10 }, CATEGORY_WRITE);
      if (!toastResult(result, { success: `“${clean}” added`, failure: "Couldn't add the category" })) return false;
      setName("");
      return true;
    });

  const rename = () =>
    run(async () => {
      if (!editing) return false;
      const clean = editing.name.trim().replace(/\s+/g, " ");
      if (!clean) return false;
      const result = await updateRows("expense_categories", { name: clean }, { id: editing.id }, { ...CATEGORY_WRITE, expect: 1 });
      if (!toastResult(result, { success: "Category renamed", failure: "Couldn't rename the category" })) return false;
      setEditing(null);
      return true;
    });

  const setActive = (category: ExpenseCategory, isActive: boolean) =>
    run(async () => {
      const result = await updateRows("expense_categories", { is_active: isActive }, { id: category.id }, { ...CATEGORY_WRITE, expect: 1 });
      return toastResult(result, { failure: "Couldn't update the category" });
    });

  // swap with the neighbour; renumber everything 10, 20, 30 … so ties can't stick
  const move = (index: number, delta: -1 | 1) =>
    run(async () => {
      const order = [...sorted];
      const to = index + delta;
      if (to < 0 || to >= order.length) return false;
      [order[index], order[to]] = [order[to], order[index]];
      for (const [i, category] of order.entries()) {
        const sortOrder = (i + 1) * 10;
        if (category.sortOrder === sortOrder) continue;
        const result = await updateRows("expense_categories", { sort_order: sortOrder }, { id: category.id }, { ...CATEGORY_WRITE, expect: 1 });
        if (!toastResult(result, { failure: "Couldn't reorder the categories" })) return true;
      }
      return true;
    });

  const remove = async (category: ExpenseCategory) => {
    const yes = await confirm({
      title: `Delete “${category.name}”?`,
      description: "Only a category with no expenses can be deleted. To keep old expenses as they are, switch it off instead.",
      tone: "danger",
      confirmLabel: "Delete category",
    });
    if (!yes) return;
    await run(async () => {
      const result = await deleteRows("expense_categories", { id: category.id }, { ...CATEGORY_WRITE, action: "delete", expect: 1 });
      return toastResult(result, { success: `“${category.name}” deleted`, failure: "Couldn't delete the category" });
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title="Expense categories"
      description="What the business spends on. Switched-off categories stay on old expenses but aren't offered for new ones."
      footer={<AdminButton onClick={onClose}>Done</AdminButton>}
    >
      {confirmElement}
      <ul className="divide-y divide-adm-line border border-adm-line">
        {sorted.map((category, index) => (
          <li key={category.id} className="flex items-center gap-2 px-3 py-2">
            {editing?.id === category.id ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void rename();
                }}
              >
                <Input aria-label="Category name" value={editing.name} maxLength={80} autoFocus onChange={(e) => setEditing({ id: category.id, name: e.target.value })} />
                <IconButton type="submit" size="sm" label="Save the name" icon={<Check className="size-3.5" />} disabled={busy} />
                <IconButton size="sm" label="Cancel renaming" icon={<X className="size-3.5" />} onClick={() => setEditing(null)} />
              </form>
            ) : (
              <>
                <span className={`min-w-0 flex-1 truncate text-[13.5px] ${category.isActive ? "text-adm-ink" : "text-adm-mute line-through"}`}>{category.name}</span>
                <Toggle label={<span className="sr-only">{`${category.name} in use`}</span>} checked={category.isActive} disabled={busy} onChange={(on) => void setActive(category, on)} />
                <IconButton size="sm" label={`Move ${category.name} up`} icon={<ArrowUp className="size-3.5" />} disabled={busy || index === 0} onClick={() => void move(index, -1)} />
                <IconButton size="sm" label={`Move ${category.name} down`} icon={<ArrowDown className="size-3.5" />} disabled={busy || index === sorted.length - 1} onClick={() => void move(index, 1)} />
                <IconButton size="sm" label={`Rename ${category.name}`} icon={<Pencil className="size-3.5" />} disabled={busy} onClick={() => setEditing({ id: category.id, name: category.name })} />
                <IconButton size="sm" label={`Delete ${category.name}`} icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={() => void remove(category)} />
              </>
            )}
          </li>
        ))}
        {sorted.length === 0 && <li className="px-3 py-3 text-[13px] text-adm-mute">No categories yet — add the first one below.</li>}
      </ul>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Input aria-label="New category name" value={name} maxLength={80} placeholder="New category, e.g. Insurance" onChange={(e) => setName(e.target.value)} />
        <AdminButton type="submit" icon={<Plus aria-hidden className="size-3.5" />} disabled={busy || !name.trim()}>
          Add
        </AdminButton>
      </form>
    </Modal>
  );
}
