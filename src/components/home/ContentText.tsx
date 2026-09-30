import { Fragment, type ReactNode } from "react";
import { Price } from "@/components/ui/Price";
import { parseRichText, tokenValue, type ContentContext, type RichColor, type RichNode } from "./content-model";

/*
 * Renders the homepage mini-markup (content-model.ts) as React nodes — never as HTML, so nothing
 * an admin types can inject markup. A plain module (no directive): server components render it
 * on the storefront, the admin Homepage tab renders it for its live previews. Prices go through
 * <Price> (display-currency aware, BUILD_SPEC §2.7) unless the caller passes `renderPrice`
 * (the admin preview shows LKR, like every admin figure).
 */

const SPAN_CLASS: Record<RichColor, string> = { lime: "text-lime", violet: "text-violet" };

type Props = {
  text: string | null | undefined;
  ctx: ContentContext;
  /** Colour class per span (the admin preview passes its own palette). */
  spanClass?: Partial<Record<RichColor, string>>;
  /** How a price renders; default <Price amount /> . */
  renderPrice?: (amount: number) => ReactNode;
};

export function ContentText({ text, ctx, spanClass, renderPrice }: Props) {
  const nodes = parseRichText(text);
  if (nodes.length === 0) return null;
  const price = renderPrice ?? ((amount: number) => <Price amount={amount} />);

  const render = (list: RichNode[], prefix: string): ReactNode[] =>
    list.map((node, index) => {
      const key = `${prefix}${index}`;
      switch (node.type) {
        case "text":
          return <Fragment key={key}>{node.value}</Fragment>;
        case "break":
          return <br key={key} />;
        case "price":
          return <Fragment key={key}>{price(node.amount)}</Fragment>;
        case "token": {
          const value = tokenValue(node.token, ctx);
          if (value === null) return null; // callers hide the whole line first (textsShown); never print a raw token
          return <Fragment key={key}>{node.token === "free_delivery_threshold" ? price(value) : String(value)}</Fragment>;
        }
        case "span":
          return (
            <span key={key} className={spanClass?.[node.color] ?? SPAN_CLASS[node.color]}>
              {render(node.children, `${key}.`)}
            </span>
          );
      }
    });

  return <>{render(nodes, "")}</>;
}
