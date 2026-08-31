"use client";

/**
 * Every script this student has photographed, and what has happened to it.
 *
 * The status is spelled out in words rather than shown as an enum, and the
 * distinction those words carry is the one that matters: "queued" is not
 * "marked", and a queue with no marker configured behind it is still a queue.
 * A student told their work is marked when it is not will stop checking.
 */

import { useEffect, useState } from "react";

interface Row {
  id: string;
  paperSlug: string | null;
  subject: string;
  classNum: number;
  status: string;
  pageCount: number;
  failureReason: string | null;
  gradedAt: string | null;
  createdAt: string;
  _count: { pages: number; answers: number };
}

const WORDS: Record<string, string> = {
  UPLOADING: "still uploading",
  QUEUED: "queued, not yet marked",
  OCR_RUNNING: "being read",
  AI_GRADING: "being marked",
  AWAITING_REVIEW: "marked — a teacher still has to check part of it",
  UNDER_REVIEW: "with a teacher now",
  GRADED: "marked",
  FAILED: "could not be marked",
};

export default function ResultsList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [list, queue] = await Promise.all([
          fetch("/api/submissions/").then((r) => r.json()),
          fetch("/api/grading/").then((r) => r.json()),
        ]);
        if (!live) return;
        if (list.error) throw new Error(list.error.message as string);
        setRows((list.submissions ?? []) as Row[]);
        if (queue?.notice) setNotice(queue.notice as string);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : "Could not load your scripts.");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" className="rounded-md bg-accent-soft p-3 text-sm">
        {error} You may need to sign in.
      </p>
    );
  }
  if (!rows) return <p className="text-sm text-ink-faint">Loading…</p>;
  if (!rows.length) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="text-sm text-ink-soft">You have not photographed an answer sheet yet.</p>
        <a
          href="/submit/"
          className="mt-3 inline-flex min-h-12 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-ink"
        >
          Photograph one
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {notice && <p className="rounded-md bg-surface-alt p-3 text-xs text-ink-soft">{notice}</p>}
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id}>
            <a
              href={`/results/${row.id}/`}
              className="flex min-h-12 flex-col rounded-lg border border-border bg-surface p-3"
            >
              <span className="text-sm font-medium">
                {row.paperSlug ?? `${row.subject}, class ${row.classNum}`}
              </span>
              <span className="mt-1 text-xs text-ink-soft">
                {WORDS[row.status] ?? row.status.toLowerCase()} · {row._count.pages} page
                {row._count.pages === 1 ? "" : "s"} · {row._count.answers} question
                {row._count.answers === 1 ? "" : "s"}
              </span>
              {row.failureReason && (
                <span className="mt-1 text-xs text-accent">{row.failureReason}</span>
              )}
            </a>
          </li>
        ))}
      </ul>
      <a
        href="/submit/"
        className="min-h-12 rounded-md border border-border px-4 py-3 text-center text-sm"
      >
        Photograph another script
      </a>
    </div>
  );
}
