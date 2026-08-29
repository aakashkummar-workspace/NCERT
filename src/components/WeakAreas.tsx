"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CLASSES, subjectsForClass, type ClassNum } from "@/lib/manifest";
import {
  chapterRangeLabel,
  chaptersOf,
  marksPerChapter,
  syllabusFor,
  unitsByWeight,
  type Unit,
} from "@/lib/syllabus";
import { chapterConfidence, type ChapterConfidence } from "@/lib/revision";

/**
 * The weak-area dashboard (Phase 5).
 *
 * Crosses the CBSE marks weightage against how confident the student actually
 * is, so revision time goes where the marks are rather than in chapter order.
 *
 * The central honesty rule here: **no data is not the same as weak.** A chapter
 * the student has never been tested on is shown as "not tested yet", never as a
 * weakness — inventing a weakness would send them to the wrong chapter just as
 * surely as hiding a real one.
 */

interface UnitRow {
  unit: Unit;
  /** Marks at risk: unit marks weighted by how shaky its chapters are. */
  atRisk: number;
  tested: number;
  chapterCount: number;
  /** 0–1 across tested chapters only; null when nothing has been tested. */
  confidence: number | null;
}

function buildRows(cls: ClassNum, subject: string, confidence: ChapterConfidence[]): UnitRow[] {
  const byChapter = new Map(confidence.map((c) => [`${c.bookCode}:${c.chapter}`, c]));

  return unitsByWeight(cls, subject).map((unit) => {
    const chapters = chaptersOf(unit);
    const perChapter = marksPerChapter(unit);

    let tested = 0;
    let confidenceSum = 0;
    let atRisk = 0;

    for (const ref of chapters) {
      const c = byChapter.get(`${ref.book.code}:${ref.chapter}`);
      if (!c) continue;
      tested++;
      confidenceSum += c.confidence;
      // A fully confident chapter puts none of its marks at risk.
      atRisk += perChapter * (1 - c.confidence);
    }

    return {
      unit,
      atRisk,
      tested,
      chapterCount: chapters.length,
      confidence: tested === 0 ? null : confidenceSum / tested,
    };
  });
}

export default function WeakAreas() {
  const [cls, setCls] = useState<ClassNum>(10);
  const [confidence, setConfidence] = useState<ChapterConfidence[] | null>(null);

  useEffect(() => {
    let live = true;
    chapterConfidence()
      .then((c) => live && setConfidence(c))
      .catch(() => live && setConfidence([]));
    return () => {
      live = false;
    };
  }, []);

  if (confidence === null) {
    return <p className="text-sm text-ink-faint">Working out where your marks are…</p>;
  }

  const subjects = subjectsForClass(cls).filter((s) => syllabusFor(cls, s.name));
  const anyTested = confidence.length > 0;

  return (
    <>
      <div className="mb-6 flex gap-2">
        {CLASSES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCls(c)}
            aria-pressed={cls === c}
            className={`min-h-11 flex-1 rounded-lg border px-3 text-sm ${
              cls === c ? "border-accent bg-accent-soft text-accent" : "border-border text-ink-soft"
            }`}
          >
            Class {c}
          </button>
        ))}
      </div>

      {!anyTested && (
        <div className="mb-6 rounded-2xl border border-dashed border-border p-5">
          <p className="text-sm text-ink-soft">
            Nothing has been tested yet, so this is the official CBSE marks weightage on its own.
            Even before any practice, it tells you which units carry the most marks.
          </p>
          <Link
            href="/practice"
            className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-accent transition-colors hover:border-accent"
          >
            Sit a practice paper
          </Link>
        </div>
      )}

      {subjects.map((subject) => {
        const rows = buildRows(cls, subject.name, confidence);
        if (rows.length === 0) return null;
        const total = syllabusFor(cls, subject.name)?.totalMarks ?? 80;
        // Ranked by marks at risk, so the top row is genuinely what to study next.
        const ranked = [...rows].sort((a, b) => b.atRisk - a.atRisk);
        const topRisk = ranked[0]?.atRisk ?? 0;

        return (
          <section key={subject.slug} className="mb-8">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-semibold">{subject.name}</h2>
              <span className="text-xs text-ink-faint">{total} marks</span>
            </div>

            {topRisk > 0.5 && (
              <p className="mb-3 rounded-xl bg-accent-soft px-3 py-2 text-sm text-accent">
                Study next: <span className="font-medium">{ranked[0].unit.name}</span> —{" "}
                {Math.round(ranked[0].atRisk)} of {ranked[0].unit.marks} marks at risk.
              </p>
            )}

            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
              {rows.map((row) => (
                <li key={row.unit.name} className="p-3">
                  <div className="flex items-baseline gap-3">
                    {/* Unit names run long ("Chemical Substances - Nature and
                        Behaviour") and are what the row is about, so wrap rather
                        than ellipse — the marks figure beside it stays fixed. */}
                    <span className="min-w-0 flex-1 text-sm font-medium">{row.unit.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-soft">
                      {row.unit.marks} marks
                    </span>
                  </div>

                  {row.chapterCount > 0 && (
                    <p className="mt-0.5 text-xs text-ink-faint">{chapterRangeLabel(row.unit)}</p>
                  )}

                  {/* Weightage bar: how big this unit is relative to the paper. */}
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-alt">
                    <div
                      className="h-full rounded-full bg-accent/40"
                      style={{ width: `${(row.unit.marks / total) * 100}%` }}
                    />
                  </div>

                  <p className="mt-2 text-xs">
                    {/*
                      A unit with no chapters is not the same as an untested one.
                      CBSE's 2025-26 Class IX syllabus still refers to the previous
                      NCERT books (Beehive, Contemporary India-I) while the app
                      carries the new NCF ones (Kaveri, Understanding Society), so
                      those units genuinely cannot be joined to a chapter. The
                      marks weightage is still correct and still worth showing.
                    */}
                    {row.chapterCount === 0 ? (
                      <span className="text-ink-faint">
                        Marks confirmed, but CBSE&apos;s Class 9 syllabus still lists the older
                        NCERT books, so these chapters cannot be linked yet.
                      </span>
                    ) : row.confidence === null ? (
                      <span className="text-ink-faint">
                        Not tested yet · {row.chapterCount}{" "}
                        {row.chapterCount === 1 ? "chapter" : "chapters"}
                      </span>
                    ) : (
                      <span className={row.atRisk > 1 ? "text-accent" : "text-ink-soft"}>
                        {Math.round(row.confidence * 100)}% confident across {row.tested} of{" "}
                        {row.chapterCount} chapters
                        {row.atRisk > 0.5 && ` · ~${Math.round(row.atRisk)} marks at risk`}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {subjects.length === 0 && (
        <p className="text-sm text-ink-soft">
          No syllabus weightage has been extracted for Class {cls} yet.
        </p>
      )}
    </>
  );
}
