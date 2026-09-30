/**
 * The admin UI kit — import everything from "@/components/admin/ui" so every tab looks and
 * behaves the same. Logic helpers live in "@/lib/admin/*" (write, query, csv, print, dates,
 * storage, toast, pagination, search, url, api). See docs/build/ADMIN_KIT.md.
 */
export { AdminButton, AdminLinkButton, IconButton, buttonClasses, type AdminButtonSize, type AdminButtonVariant } from "./Button";
export { AdminToaster } from "./AdminToaster";
export { ConfirmDialog, useConfirm, type ConfirmDialogProps, type ConfirmOptions, type ConfirmOutcome } from "./ConfirmDialog";
export { DataTable, nextSort, sortRows, type DataColumn, type DataTableProps, type RowAction, type SortDirection, type SortState } from "./DataTable";
export { DateTime } from "./DateTime";
export { Drawer } from "./Drawer";
export { EmptyState } from "./EmptyState";
export {
  DateTimeInput,
  Field,
  FieldError,
  Input,
  MoneyInput,
  NumberInput,
  Select,
  TagInput,
  Textarea,
  Toggle,
  type FieldProps,
  type SelectOption,
} from "./fields";
export { ImageGalleryUploader, ImageUploader } from "./ImageUploader";
export { KpiTile, changeBetween, formatChange, type KpiDelta } from "./KpiTile";
export { Modal, type ModalProps, type ModalSize } from "./Modal";
export { Money } from "./Money";
export { AdminPagination, AdminPagination as Pagination } from "./Pagination";
export { AdminNotice, MissingMigrationBanner, QueryError, Skeleton } from "./QueryState";
export { SectionCard, TabHeader } from "./SectionCard";
export { StatusBadge, type StatusTone } from "./StatusBadge";
export { Tabs, type TabItem } from "./Tabs";
export { DateRangePicker, SearchInput, Toolbar, type DateRangePickerProps, type SearchInputProps } from "./Toolbar";
