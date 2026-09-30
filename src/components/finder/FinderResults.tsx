"use client";

import Link from "next/link";
import { ArrowLeft, RotateCcw } from "lucide-react";
import type { Ref } from "react";
import { AddToCartButton } from "@/components/product/AddToCartButton";
import { ProductImage } from "@/components/product/ProductImage";
import { BracketLink } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Notice } from "@/components/ui/Notice";
import { Price } from "@/components/ui/Price";
import { productHref } from "@/lib/catalogue-shared";
import { pad2 } from "@/lib/format";
import { answerLabel, brandFromAvoid, productsIn, type FinderAnswers, type FinderCatalogue, type FinderPick, type FinderProduct, type UseCase } from "@/lib/quiz";

type Props = {
  picks: FinderPick[];
  answers: FinderAnswers;
  catalogue: FinderCatalogue;
  onChangeAnswers: () => void;
  onStartOver: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
};

/** The shopper's answers as short chips ("Laptops", "Gaming", "Avoid: Vanta"). */
function answerChips(answers: FinderAnswers, catalogue: FinderCatalogue): string[] {
  const chips: string[] = [];
  if (answers.category) chips.push(answerLabel("category", answers.category, catalogue));
  if (answers.use) chips.push(answerLabel("use", answers.use));
  if (answers.budget) chips.push(answerLabel("budget", answers.budget));
  if (answers.portability === "light") chips.push(answerLabel("portability", "light"));
  if (answers.avoid.length > 0) {
    chips.push(`Avoid: ${answers.avoid.map((token) => brandFromAvoid(token) ?? answerLabel("avoid", token)).join(", ")}`);
  }
  return chips;
}

function ResultCard({ pick, product, rank }: { pick: FinderPick; product: FinderProduct; rank: number }) {
  const card = product.card;
  const href = productHref(card.id);
  return (
    <article className="group relative grid grid-cols-[88px_1fr] gap-4 border border-line bg-surface p-4 transition-colors duration-150 hover:border-ink sm:grid-cols-[140px_1fr] sm:p-5 lg:grid-cols-[180px_1fr_auto] lg:gap-6">
      <Cross className="-top-[6px] -left-[6px] text-ink opacity-0 transition-opacity group-hover:opacity-100" />
      <Cross className="-right-[6px] -bottom-[6px] text-ink opacity-0 transition-opacity group-hover:opacity-100" />

      <Link href={href} tabIndex={-1} aria-hidden className="bg-grid relative block aspect-square self-start overflow-hidden border border-line bg-paper [--grid-size:20px]">
        <span className="display absolute top-1.5 left-2 z-10 text-2xl leading-none text-transparent [-webkit-text-stroke:1px_var(--color-ink)]">{pad2(rank)}</span>
        <ProductImage
          src={card.imageUrl}
          alt={card.name}
          categoryId={card.categoryId}
          sizes="(min-width: 1024px) 180px, (min-width: 640px) 140px, 88px"
          decorative
          className="absolute inset-0 size-full object-contain p-3 transition-transform duration-500 ease-brut group-hover:scale-[1.06]"
        />
      </Link>

      <div className="min-w-0">
        <p className="label font-semibold text-violet-ink">
          <span className="sr-only">Pick {rank}: </span>
          {pick.style}
        </p>
        <h3 className="mt-1.5 text-lg leading-6 font-medium">
          <Link href={href} className="hover:underline hover:underline-offset-2">
            {card.name}
          </Link>
        </h3>
        {card.subtitle && <p className="label mt-1 text-mute normal-case tracking-normal">{card.subtitle}</p>}
        <p className="mt-3 max-w-2xl text-[15px] leading-6 text-ink-2">{pick.reason}</p>
      </div>

      <div className="col-span-2 flex flex-wrap items-end justify-between gap-3 border-t border-line pt-4 lg:col-span-1 lg:flex-col lg:items-end lg:justify-start lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
        <p className="label bg-lime px-2 py-1 font-bold text-ink">{pick.match}% match</p>
        <p className="font-mono leading-tight whitespace-nowrap tabular-nums lg:text-right">
          {card.variantCount > 1 && <span className="block text-[11px] text-mute">From</span>}
          <Price amount={card.price} compareAt={card.compareAtPrice} compareClassName="block text-xs text-mute" className="text-lg font-bold" />
        </p>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <AddToCartButton product={card} variant="full" />
          <BracketLink href={href}>View</BracketLink>
        </div>
      </div>
    </article>
  );
}

/**
 * The picks (blueprint §9.14 steps 5–7): up to three, each with its style, the one-sentence
 * reason from its own drivers, the match % scaled against the best available pick, the price
 * through <Price>, and add-to-basket / view. Honest notices when fewer than three products fit,
 * or when nothing in stock is listed for the use they asked about.
 */
export function FinderResults({ picks, answers, catalogue, onChangeAnswers, onStartOver, headingRef }: Props) {
  const byId = new Map(catalogue.products.map((p) => [p.id, p]));
  const shown = picks.map((pick) => ({ pick, product: byId.get(pick.productId) })).filter((row): row is { pick: FinderPick; product: FinderProduct } => Boolean(row.product));
  const categoryName = answers.category ? answerLabel("category", answers.category, catalogue) : "our range";
  const use = answers.use;
  const useBacked = !use || shown.some(({ product }) => product.uses.includes(use));
  // Why no pick backs the use: the range lists nothing for it, or everything that does was refused.
  const useInRange = Boolean(use) && productsIn(catalogue, answers.category).some((product) => product.uses.includes(use as UseCase));
  const chips = answerChips(answers, catalogue);

  return (
    <section aria-labelledby="finder-results">
      <div className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-ink pb-4">
        <div>
          <p className="label mb-1.5 font-semibold text-violet-ink">/Results</p>
          <h2 id="finder-results" ref={headingRef} tabIndex={-1} className="display text-[clamp(2rem,4vw,3rem)] outline-none">
            Your picks<span className="text-violet">_</span>
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <button type="button" onClick={onChangeAnswers} className="label inline-flex min-h-10 items-center gap-2 font-semibold transition-colors hover:text-violet-ink">
            <ArrowLeft aria-hidden className="size-4" /> Change answers
          </button>
          <button type="button" onClick={onStartOver} className="label inline-flex min-h-10 items-center gap-2 font-semibold transition-colors hover:text-violet-ink">
            <RotateCcw aria-hidden className="size-4" /> Start over
          </button>
        </div>
      </div>

      {chips.length > 0 && (
        <ul aria-label="Your answers" className="mt-4 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <li key={chip} className="label border border-line bg-surface px-2 py-1 text-ink-2">
              {chip}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 space-y-3">
        {shown.length === 0 && (
          <Notice tone="info" title="Nothing fits all of that">
            Nothing in our {categoryName.toLowerCase()} range fits everything you asked. Try avoiding fewer things.
          </Notice>
        )}
        {shown.length > 0 && !useBacked && use && (
          <Notice tone="info">
            {useInRange
              ? `The ${categoryName.toLowerCase()} we list for ${answerLabel("use", use).toLowerCase()} are ones you asked to avoid, so ${shown.length === 1 ? "this is the closest match" : "these are the closest matches"} to your other answers.`
              : `Nothing in our ${categoryName.toLowerCase()} range is listed for ${answerLabel("use", use).toLowerCase()} yet, so ${shown.length === 1 ? "this is the closest match" : "these are the closest matches"} to your other answers.`}
          </Notice>
        )}
        {shown.length > 0 && shown.length < 3 && (
          <Notice tone="info">
            Only {shown.length === 1 ? "one product fits" : `${shown.length} products fit`} everything you asked.
          </Notice>
        )}
      </div>

      {shown.length > 0 && (
        <>
          <ol className="mt-6 grid gap-4">
            {shown.map(({ pick, product }, i) => (
              <li key={pick.productId}>
                <ResultCard pick={pick} product={product} rank={i + 1} />
              </li>
            ))}
          </ol>
          <p className="label mt-4 text-mute normal-case tracking-normal">Match % compares these picks with the best fit in our current range. Prices and availability are confirmed at checkout.</p>
        </>
      )}
    </section>
  );
}
