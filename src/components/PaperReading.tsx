"use client";

import Link from "next/link";
import { useState } from "react";
import DownloadButton from "@/components/DownloadButton";
import PaperViewer from "@/components/PaperViewer";
import { formatDuration, paperPdfPath, schemePdfPath, type Paper } from "@/lib/papers";

/**
 * A paper with no derived mark grid: everything the runner offers except the
 * two things that need the grid, the clock and the scoring sheet.
 *
 * PaperAttempt is deliberately not reused. Its whole shape is the four phases of
 * an exam, and half a scoring UI wired to an empty question list is exactly the
 * screen this replaces — a three-hour timer running against nothing to mark. The
 * routing decision lives in the page, so the scorable papers reach the runner on
 * the same path they always did.
 *
 * The scheme is not locked here, because nothing is being timed: a paper you can
 * only read is read alongside its scheme. Panes still mount one at a time, so
 * the PDF you are not looking at is not downloading.
 */

type Pane = "about" | "paper" | "scheme";

const PANES: { key: Pane; label: string }[] = [
  { key: "about", label: "About" },
  { key: "paper", label: "Paper" },
  { key: "scheme", label: "Scheme" },
];

export default function PaperReading({ paper }: { paper: Paper }) {
  const [pane, setPane] = useState<Pane>("about");

  // One harvested term paper prints no total on its cover, so the total is a
  // fact this screen may simply not have. "0 marks" would be a wrong one.
  const marks = paper.maxMarks > 0 ? `${paper.maxMarks} marks` : "";

  return (
    <div className="flex w-full flex-1 flex-col">
      <div className="shrink-0 border-b border-border bg-paper px-4 py-2.5">
        <div className="mx-auto max-w-3xl">
          {/* The pill is its own element rather than the tail of that line: a
              subject like "English (Language & Literature)" eats the width of a
              phone, and a marker that truncates away is worse than none. */}
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs text-ink-faint">
              {paper.subject}
              {marks ? ` · ${marks}` : ""}
            </p>
            <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
              Read only
            </span>
          </div>
          <div className="mt-2 flex gap-1 rounded-xl bg-surface-alt p-1">
            {PANES.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPane(p.key)}
                aria-pressed={pane === p.key}
                className={`min-h-11 flex-1 rounded-lg px-3 text-xs font-medium transition-colors ${
                  pane === p.key ? "bg-surface text-ink shadow-sm" : "text-ink-faint"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {pane === "about" ? (
        <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6">
          <div className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-lg font-semibold tracking-tight">{paper.title}</h2>
            <p className="mt-1 text-sm text-ink-soft">
              Class {paper.class} · {paper.subject}
              {paper.code ? ` · Code ${paper.code}` : ""} · {paper.session}
            </p>

            {/* No question count: how the paper divides into questions is the
                one thing that could not be read off it, and the harvested
                figure is 0 on a third of these. */}
            <dl
              className={`mt-4 grid gap-3 text-center ${marks ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {[
                ...(marks ? [{ label: "Marks", value: String(paper.maxMarks) }] : []),
                { label: "Time", value: formatDuration(paper.durationMinutes) },
              ].map((item) => (
                <div key={item.label} className="rounded-xl bg-surface-alt px-2 py-3">
                  <dt className="text-xs uppercase tracking-wider text-ink-faint">{item.label}</dt>
                  <dd className="mt-0.5 text-base font-semibold tabular-nums">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="mt-4 rounded-2xl border border-border bg-surface p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Read only
            </h3>
            <ul className="mt-3 space-y-2 text-sm text-ink-soft">
              <li>
                The paper and the official marking scheme are both here in full. Read either one,
                or save both for offline.
              </li>
              <li>
                There is no clock and no scoring sheet: this paper does not print a mark grid the
                app can read, and a guessed one would have you marking to the wrong numbers.
              </li>
              <li>
                Marks are printed beside every question. Sit it under your own clock —{" "}
                {formatDuration(paper.durationMinutes)}
                {marks ? ` for ${marks}` : ""} — and mark against the scheme.
              </li>
            </ul>

            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-3">
              <div className="flex items-center gap-2">
                <DownloadButton
                  url={paperPdfPath(paper)}
                  bytes={paper.paperBytes}
                  label={`${paper.subject} question paper`}
                  showLabel
                />
                <span className="text-xs text-ink-soft">Question paper</span>
              </div>
              <div className="flex items-center gap-2">
                <DownloadButton
                  url={schemePdfPath(paper)}
                  bytes={paper.schemeBytes}
                  label={`${paper.subject} marking scheme`}
                  showLabel
                />
                <span className="text-xs text-ink-soft">Marking scheme</span>
              </div>
            </div>
          </div>

          <Link
            href="/practice"
            className="mt-4 flex min-h-14 items-center justify-center rounded-2xl border border-border px-4 py-3 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
          >
            Papers you can sit and score
          </Link>
        </main>
      ) : (
        <div className="flex min-h-0 flex-1 p-2">
          {pane === "paper" ? (
            <PaperViewer url={paperPdfPath(paper)} label="question paper" className="flex-1" />
          ) : (
            <PaperViewer url={schemePdfPath(paper)} label="marking scheme" className="flex-1" />
          )}
        </div>
      )}
    </div>
  );
}
