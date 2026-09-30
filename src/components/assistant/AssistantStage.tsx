"use client";

import type { ReactNode } from "react";
import type { AssistantOrderView, AssistantStage as AssistantStageData } from "@/lib/assistant/types";
import { StageOrderLookup } from "./StageOrderLookup";
import { StageProductExhibit } from "./StageProductExhibit";
import { StageQuestion } from "./StageQuestion";

/**
 * The display zone beside the conversation (blueprint §10.3): ONE thing at a time — products
 * (≤ 3 server-resolved cards), a question with tappable tiles, or the private order-lookup form.
 * The stage is a discriminated union: every kind is handled here, exhaustively.
 */
export function AssistantStage({
  stage,
  sessionId,
  busy,
  onAnswer,
  onAdded,
  onOrderFound,
  onNavigate,
}: {
  stage: AssistantStageData;
  sessionId: string;
  busy: boolean;
  onAnswer: (answer: string) => void;
  onAdded: (productId: number) => void;
  onOrderFound: (order: AssistantOrderView) => void;
  onNavigate?: () => void;
}) {
  let body: ReactNode;
  let title: string;
  switch (stage.kind) {
    case "products":
      title = stage.products.length === 1 ? "On display" : `On display · ${stage.products.length}`;
      body = <StageProductExhibit products={stage.products} onAdded={onAdded} onNavigate={onNavigate} />;
      break;
    case "question":
      title = "Quick question";
      body = <StageQuestion question={stage.question} onAnswer={onAnswer} disabled={busy} />;
      break;
    case "order_lookup":
      title = "Order lookup";
      body = <StageOrderLookup key={`${sessionId}-${stage.prefillOrderRef ?? ""}`} sessionId={sessionId} prefill={stage.prefillOrderRef} onFound={onOrderFound} />;
      break;
    default: {
      const unreachable: never = stage;
      return unreachable;
    }
  }
  return (
    <section aria-label={title} className="max-h-[48%] shrink-0 overflow-y-auto overscroll-contain border-b border-ink bg-paper px-4 py-3">
      <p className="label mb-2 flex items-center gap-2 font-semibold text-ink-2">
        <span aria-hidden className="size-1.5 bg-violet" />
        {title}
      </p>
      {body}
    </section>
  );
}
