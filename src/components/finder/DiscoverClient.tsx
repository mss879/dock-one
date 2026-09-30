"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import {
  AVOID_NOTHING,
  EMPTY_ANSWERS,
  answersRecord,
  countMatches,
  questionsFor,
  recommend,
  type AskedQuestion,
  type FinderAnswers,
  type FinderCatalogue,
  type QuestionOption,
} from "@/lib/quiz";
import { SIGNED_OUT_EVENT } from "@/lib/viewer";
import { EmailPicksForm } from "./EmailPicksForm";
import { FinderResults } from "./FinderResults";
import { QuestionStep } from "./QuestionStep";
import { getFinderSessionId, resetFinderSession } from "./session";

type Props = {
  /** Per-product vectors from fetchCatalogueForFinder() (the lexicon never reaches the browser). */
  catalogue: FinderCatalogue;
  /** Email is configured on the server — only then is "email me my picks" offered (P15). */
  emailEnabled: boolean;
};

/** Record the answers when the results appear (answers only; the server re-derives the picks). Best-effort. */
function capture(answers: FinderAnswers) {
  try {
    void fetch("/api/quiz", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      cache: "no-store",
      keepalive: true,
      body: JSON.stringify({ sessionId: getFinderSessionId(), answers: answersRecord(answers), company: "" }),
    }).catch(() => {});
  } catch {
    // capture never gets in the shopper's way (P5)
  }
}

/**
 * /discover — the guided finder (blueprint §9.14, BUILD_SPEC §4.5). One question at a time, with
 * back and progress; only the options the chosen category's stock can honour; the SAME
 * `recommend()` the assistant and the capture route use, run here in the browser over the
 * server-built vectors; results with three picks; the email offer only after the results.
 */
export function DiscoverClient({ catalogue, emailEnabled }: Props) {
  const [answers, setAnswers] = useState<FinderAnswers>(EMPTY_ANSWERS);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  /** The shopper explicitly chose "Nothing" on the avoid question (display state only). */
  const [avoidNone, setAvoidNone] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null);
  /** Move focus only after the shopper acts — never on page load. */
  const interacted = useRef(false);

  const questions = useMemo(() => questionsFor(catalogue, answers.category), [catalogue, answers.category]);
  /** Before a category is chosen, show the longest run any category would take. */
  const longest = useMemo(
    () => Math.max(1, ...catalogue.categories.map((c) => questionsFor(catalogue, c.id).length)),
    [catalogue],
  );
  const total = answers.category ? questions.length : longest;
  const question: AskedQuestion | undefined = questions[Math.min(step, questions.length - 1)];
  const picks = useMemo(() => (done ? recommend(answers, catalogue) : []), [done, answers, catalogue]);

  useEffect(() => {
    if (!interacted.current) return;
    (done ? resultsRef.current : headingRef.current)?.focus();
  }, [step, done]);

  // Sign-out clears per-person state (blueprint §9.13): a new session id and a fresh finder.
  useEffect(() => {
    const onSignedOut = () => {
      resetFinderSession();
      setAnswers(EMPTY_ANSWERS);
      setStep(0);
      setDone(false);
      setAvoidNone(false);
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  function finish(final: FinderAnswers) {
    const results = recommend(final, catalogue);
    setDone(true);
    track("finder_complete", { value: results.length, metadata: { category: final.category ?? "" } });
    capture(final);
  }

  function goTo(next: FinderAnswers, fromStep: number) {
    const run = questionsFor(catalogue, next.category);
    if (fromStep + 1 < run.length) setStep(fromStep + 1);
    else finish(next);
  }

  function choose(current: AskedQuestion, option: QuestionOption) {
    interacted.current = true;
    if (current.kind === "multi") {
      if (option.value === AVOID_NOTHING) {
        setAnswers((a) => ({ ...a, avoid: [] }));
        setAvoidNone(true);
        return;
      }
      setAvoidNone(false);
      setAnswers((a) => ({ ...a, avoid: a.avoid.includes(option.value) ? a.avoid.filter((v) => v !== option.value) : [...a.avoid, option.value] }));
      return;
    }
    let next: FinderAnswers;
    if (current.id === "category") {
      // A new category starts a fresh run: its questions and options differ.
      next = option.value === answers.category ? answers : { ...EMPTY_ANSWERS, category: option.value };
      if (option.value !== answers.category) setAvoidNone(false);
    } else {
      next = { ...answers, [current.id]: option.value };
    }
    setAnswers(next);
    goTo(next, step);
  }

  function back() {
    interacted.current = true;
    if (done) {
      setDone(false);
      setStep(Math.max(0, questions.length - 1));
      return;
    }
    setStep((s) => Math.max(0, s - 1));
  }

  function startOver() {
    interacted.current = true;
    setAnswers(EMPTY_ANSWERS);
    setAvoidNone(false);
    setDone(false);
    setStep(0);
  }

  // Refusals that would leave nothing are disabled while the shopper builds the avoid list.
  const disabled = useMemo(() => {
    const blocked = new Set<string>();
    if (!question || question.kind !== "multi") return blocked;
    for (const option of question.options) {
      if (option.value === AVOID_NOTHING || answers.avoid.includes(option.value)) continue;
      if (countMatches({ category: answers.category, avoid: [...answers.avoid, option.value] }, catalogue) === 0) blocked.add(option.value);
    }
    return blocked;
  }, [question, answers.avoid, answers.category, catalogue]);

  if (done) {
    return (
      <div>
        <FinderResults picks={picks} answers={answers} catalogue={catalogue} onChangeAnswers={back} onStartOver={startOver} headingRef={resultsRef} />
        {emailEnabled && picks.length > 0 && <EmailPicksForm answers={answers} count={picks.length} />}
      </div>
    );
  }

  if (!question) return null;

  const selected =
    question.id === "avoid"
      ? avoidNone
        ? [AVOID_NOTHING]
        : answers.avoid
      : question.id === "category"
        ? answers.category
          ? [answers.category]
          : []
        : answers[question.id]
          ? [answers[question.id] as string]
          : [];

  const progress = Math.round(((step + 1) / Math.max(total, 1)) * 100);

  return (
    <div className="max-w-4xl">
      <div aria-hidden className="mb-6 h-1 bg-line">
        <div className="h-full bg-violet transition-[width] duration-300 ease-brut" style={{ width: `${progress}%` }} />
      </div>
      <QuestionStep
        key={question.id}
        question={question}
        index={step}
        total={total}
        selected={selected}
        disabled={disabled}
        onChoose={(option) => choose(question, option)}
        onContinue={question.kind === "multi" ? () => goTo(answers, step) : undefined}
        onBack={step > 0 ? back : undefined}
        headingRef={headingRef}
      />
    </div>
  );
}
