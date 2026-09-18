import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "light" | "accent";

const shell: Record<Variant, string> = {
  primary: "bg-ink text-paper",
  light: "bg-paper text-ink",
  accent: "bg-violet text-white hover:bg-ink",
};
const arrow: Record<Variant, string> = {
  primary: "bg-violet text-white group-hover/btn:bg-lime group-hover/btn:text-ink",
  light: "bg-lime text-ink group-hover/btn:bg-violet group-hover/btn:text-white",
  accent: "bg-ink/25 text-white",
};

type Props = {
  variant?: Variant;
  size?: "md" | "lg";
  withArrow?: boolean;
  children: ReactNode;
  className?: string;
} & (({ href: string } & Omit<ComponentProps<typeof Link>, "href" | "className" | "children">) | ({ href?: undefined } & Omit<ComponentProps<"button">, "className" | "children">));

/** Block button with the arrow cell from the CYBR_ reference. */
export function Button({ variant = "primary", size = "md", withArrow = true, children, className = "", ...rest }: Props) {
  const height = size === "lg" ? "h-13" : "h-11";
  const classes = `group/btn label inline-flex ${height} shrink-0 items-stretch font-semibold transition-colors duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-40 ${shell[variant]} ${className}`;
  const inner = (
    <>
      <span className="flex flex-1 items-center justify-center px-5 whitespace-nowrap">{children}</span>
      {withArrow && (
        <span className={`grid aspect-square h-full place-items-center transition-colors duration-150 ${arrow[variant]}`}>
          <ArrowUpRight aria-hidden className="size-4 transition-transform duration-150 group-hover/btn:translate-x-0.5 group-hover/btn:-translate-y-0.5" />
        </span>
      )}
    </>
  );
  if (rest.href !== undefined) {
    const { href, ...linkProps } = rest;
    return (
      <Link href={href} className={classes} {...linkProps}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" className={classes} {...rest}>
      {inner}
    </button>
  );
}

/** `[ VIEW ALL ]` text link — the brackets spread on hover. */
export function BracketLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`group/br label inline-flex min-h-10 items-center gap-1.5 font-semibold transition-colors hover:text-violet-ink ${className}`}>
      <span aria-hidden className="transition-transform duration-150 group-hover/br:-translate-x-0.5">[</span>
      {children}
      <span aria-hidden className="transition-transform duration-150 group-hover/br:translate-x-0.5">]</span>
    </Link>
  );
}
