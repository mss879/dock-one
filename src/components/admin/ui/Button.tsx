"use client";

import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/**
 * Admin buttons — denser than the storefront's block buttons, same language (ink fill, violet
 * accent, mono label). Destructive actions are ink with a "!" block (no reds, DESIGN.md §3) and
 * always sit behind a ConfirmDialog.
 */

export type AdminButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
export type AdminButtonSize = "sm" | "md";

const variants: Record<AdminButtonVariant, string> = {
  primary: "border border-adm-ink bg-adm-ink text-white hover:bg-adm-ink-2 hover:border-adm-ink-2",
  accent: "border border-adm-accent bg-adm-accent text-white hover:bg-adm-accent-ink hover:border-adm-accent-ink",
  secondary: "border border-adm-line-strong bg-adm-panel text-adm-ink hover:border-adm-ink",
  ghost: "border border-transparent bg-transparent text-adm-ink-2 hover:bg-adm-panel-2 hover:text-adm-ink",
  // Solid and unmistakable — for the confirming button of a destructive action (ConfirmDialog).
  danger: "border border-adm-ink bg-adm-ink text-white hover:bg-adm-ink-2 hover:border-adm-ink-2",
};

const sizes: Record<AdminButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-[11px]",
  md: "h-10 gap-2 px-3.5 text-[12px]",
};

export function buttonClasses(variant: AdminButtonVariant = "secondary", size: AdminButtonSize = "md", className = ""): string {
  return `inline-flex shrink-0 select-none items-center justify-center font-mono font-semibold uppercase tracking-[0.06em] whitespace-nowrap transition-colors duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 ${variants[variant]} ${sizes[size]} ${className}`;
}

type CommonProps = {
  variant?: AdminButtonVariant;
  size?: AdminButtonSize;
  /** Leading icon (lucide element). */
  icon?: ReactNode;
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  children?: ReactNode;
  className?: string;
};

export function AdminButton({
  variant = "secondary",
  size = "md",
  icon,
  loading = false,
  disabled,
  children,
  className = "",
  type = "button",
  ...rest
}: CommonProps & Omit<ComponentProps<"button">, "children" | "className">) {
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClasses(variant, size, className)} {...rest}>
      {variant === "danger" && !loading && (
        <span aria-hidden className="-ml-0.5 grid size-4 place-items-center bg-adm-signal text-[10px] leading-none text-adm-ink">
          !
        </span>
      )}
      {loading ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** A Link styled as an admin button (e.g. "View on store"). External targets get rel=noopener. */
export function AdminLinkButton({
  href,
  variant = "secondary",
  size = "md",
  icon,
  children,
  className = "",
  external = false,
}: CommonProps & { href: string; external?: boolean }) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClasses(variant, size, className)}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClasses(variant, size, className)}>
      {icon}
      {children}
    </Link>
  );
}

/** Square icon-only button. `label` is required (aria-label + tooltip). */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  className = "",
  type = "button",
  loading = false,
  disabled,
  ...rest
}: { label: string; icon: ReactNode; variant?: AdminButtonVariant; size?: AdminButtonSize; loading?: boolean; className?: string } & Omit<
  ComponentProps<"button">,
  "children" | "className" | "aria-label"
>) {
  const square = size === "sm" ? "size-8" : "size-10";
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${buttonClasses(variant, size, `${square} px-0! ${className}`)}`}
      {...rest}
    >
      {loading ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : icon}
    </button>
  );
}
