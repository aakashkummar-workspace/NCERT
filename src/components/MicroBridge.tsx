"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  bridgeHref,
  rememberDismissed,
  rememberOffered,
  rememberTaken,
  type Bridge,
  type BridgeOffer,
  type ChapterPrerequisite,
  type OutOfCorpusPrerequisite,
} from "@/lib/bridge";

/**
 * The micro-bridge, in two pieces: the offer, and the review it leads to.
 *
 * The copy is the feature. A student who has just got four questions wrong does
 * not need to be told they got four questions wrong, and they certainly do not
 * need to be stopped. So:
 *
 *  - the offer names the *chapter*, not the student ("Quadratic Equations leans
 *    on…", never "you are weak in…");
 *  - the time cost is stated before they agree to anything, because a student
 *    mid-revision is deciding whether they can afford two minutes;
 *  - "Not now" is a full-size button beside "Show me", not a grey × in a
 *    corner, and it says nothing back;
 *  - nothing anywhere is blocked, and the offer says so in one line, because
 *    the student's first question is whether this is a punishment.
 *
 * The review writes no revision card and produces no score. It is the one
 * screen in the app that measures nothing — which is the whole point, and the
 * reason /revise and /progress need no bridge-specific code.
 */

function minutesLabel(minutes: number): string {
  return minutes === 1 ? "1 min" : `${minutes} min`;
}

function joinTitles(steps: ChapterPrerequisite[]): string {
  const titles = steps.map((s) => s.title);
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/**
 * The offer, rendered at the moment of the miss.
 *
 * Additive by design: it takes an offer and a callback and touches no store the
 * quiz owns, so any flow can drop it in without changing what that flow does.
 */
export function MicroBridgeOffer({
  offer,
  onClose,
}: {
  offer: BridgeOffer;
  /** Called after either button; the host decides whether to unmount. */
  onClose?: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const { bridge } = offer;

  useEffect(() => {
    // Recorded on display, so the rate limiter counts what the student saw
    // rather than what we intended to show them.
    rememberOffered(bridge.id);
  }, [bridge.id]);

  if (dismissed) {
    return (
      <p className="rounded-2xl border border-border bg-surface px-4 py-3 text-xs text-ink-faint">
        Hidden. It is under Bridges if you change your mind.
      </p>
    );
  }

  return (
    <section
      aria-label="Optional catch-up"
      className="rounded-2xl border border-accent/40 bg-accent-soft/60 p-4"
    >
      <p className="text-sm font-medium">
        {bridge.concept ?? bridge.title} leans on {joinTitles(bridge.steps)}.
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        {minutesLabel(bridge.minutes)} on that first. Nothing is scored, and nothing is locked — you
        can carry straight on without it.
      </p>

      <div className="mt-3 flex gap-2">
        <Link
          href={bridgeHref(bridge)}
          onClick={() => onClose?.()}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
        >
          Show me
        </Link>
        <button
          type="button"
          onClick={() => {
            rememberDismissed(bridge.id);
            setDismissed(true);
            onClose?.();
          }}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border px-4 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          Not now
        </button>
      </div>
    </section>
  );
}

function Step({ step, index }: { step: ChapterPrerequisite; index: number }) {
  return (
    <li className="rounded-2xl border border-border bg-surface p-4">
      <p className="text-xs text-ink-faint">
        Step {index + 1} · Class {step.classNum} {step.subject} · Chapter {step.chapter} ·{" "}
        {minutesLabel(step.minutes)}
      </p>
      <h2 className="mt-0.5 text-base font-semibold leading-tight">{step.title}</h2>
      <p className="mt-1 text-sm text-ink-soft">{step.why}</p>

      <ul className="mt-3 space-y-2">
        {step.recap.map((line) => (
          <li key={line} className="flex gap-2 text-sm leading-relaxed">
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent/60" />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <Link
        href={step.href}
        className="mt-3 inline-flex min-h-11 items-center text-sm text-accent transition-colors hover:underline"
      >
        Open the full chapter
      </Link>
    </li>
  );
}

function Gap({ gap }: { gap: OutOfCorpusPrerequisite }) {
  return (
    <li className="rounded-2xl border border-dashed border-border p-4">
      <p className="text-xs text-ink-faint">Class {gap.grade} · not in this app</p>
      <h2 className="mt-0.5 text-base font-semibold leading-tight">{gap.topic}</h2>
      <p className="mt-1 text-sm text-ink-soft">{gap.why}</p>
      <p className="mt-2 text-sm text-ink-faint">
        {gap.note ?? "This app mirrors Class 9 and 10 only."} There is nothing here to open, so this
        one is worth a look in your old book.
      </p>
    </li>
  );
}

/**
 * The review. One bridge per block, each independently under three minutes, so
 * a student who only wants the concept-level one can stop after it.
 */
export default function MicroBridge({ bridges }: { bridges: Bridge[] }) {
  const router = useRouter();
  const offerable = bridges.filter((b) => b.steps.length > 0);
  const first = offerable[0];

  useEffect(() => {
    // Opening the review is the "yes". Recording it here rather than on the
    // offer's button means a bridge reached from /bridge, a link or a back
    // button counts the same as one reached from the offer.
    for (const bridge of bridges) rememberTaken(bridge.id);
  }, [bridges]);

  if (bridges.length === 0) {
    return <p className="text-sm text-ink-soft">No run-up has been written for this chapter yet.</p>;
  }

  return (
    <>
      {first ? (
        <p className="mb-5 text-sm text-ink-soft">
          What this chapter assumes you already have. About {minutesLabel(first.minutes)}, and
          nothing here is scored.
        </p>
      ) : (
        <p className="mb-5 text-sm text-ink-soft">
          This chapter builds on Class 6–8 work, and those books are not in this app. Rather than
          send you to a Class 9 chapter that only sounds similar, here is what is actually missing.
        </p>
      )}

      {bridges.map((bridge) => (
        <section key={bridge.id} className="mb-6">
          {bridge.concept && (
            <h2 className="mb-2 text-sm font-semibold">
              {bridge.concept}{" "}
              <span className="font-normal text-ink-faint">· {minutesLabel(bridge.minutes)}</span>
            </h2>
          )}
          <ul className="space-y-3">
            {bridge.steps.map((step, i) => (
              <Step key={`${step.bookCode}:${step.chapter}`} step={step} index={i} />
            ))}
            {bridge.gaps.map((gap) => (
              <Gap key={gap.topic} gap={gap} />
            ))}
          </ul>
        </section>
      ))}

      {first && (
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-sm font-medium">Does that click?</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => router.back()}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
            >
              Yes — back to it
            </button>
            <Link
              href={first.steps[0].href}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border px-4 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
            >
              Not yet — read it properly
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
