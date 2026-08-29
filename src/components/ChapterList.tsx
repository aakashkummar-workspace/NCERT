import Link from "next/link";
import ChapterRating from "@/components/ChapterRating";
import DownloadButton from "@/components/DownloadButton";
import { formatBytes, pdfPath, type Book, type Chapter, type ClassNum } from "@/lib/manifest";
import { unitOfChapter, type Unit } from "@/lib/syllabus";

/**
 * A run of consecutive chapters that share one CBSE syllabus unit.
 *
 * The weightage the app has is per *unit*, never per chapter — CBSE simply does
 * not publish a chapter figure. Printing an even split on every row ("~6 marks")
 * repeated the same number down the whole unit and said nothing a heading could
 * not say once, so the unit is named once above the chapters it covers and the
 * row is left to the thing a student actually scans for: the title.
 */
interface Group {
  /** null for chapters CBSE's syllabus does not map — most of Class 9. */
  unit: Unit | null;
  /** true when an earlier group already carried this unit's marks. */
  continued: boolean;
  chapters: Chapter[];
}

/**
 * Groups chapters in book order, never in syllabus order: a student looks for
 * "chapter 7", so the numbers must stay ascending. A unit whose chapters are
 * not contiguous (Class 10 Maths splits Geometry across chapters 6 and 10)
 * therefore heads more than one group, and only the first states the marks —
 * repeating "15 marks" twice would read as 30.
 */
function groupByUnit(book: Book, cls: ClassNum, subject: string): Group[] {
  const groups: Group[] = [];
  const counted = new Set<string>();

  for (const ch of book.chapters) {
    // `unitOfChapter` hands back the shared object from the syllabus array, so
    // identity is a safe test for "same unit as the row above".
    const unit = unitOfChapter(cls, subject, book.code, ch.n) ?? null;
    const last = groups[groups.length - 1];

    if (last && last.unit === unit) {
      last.chapters.push(ch);
      continue;
    }
    groups.push({ unit, continued: unit ? counted.has(unit.name) : false, chapters: [ch] });
    if (unit) counted.add(unit.name);
  }
  return groups;
}

export default function ChapterList({
  book,
  cls,
  subject,
}: {
  book: Book;
  cls: ClassNum;
  subject: string;
}) {
  const groups = groupByUnit(book, cls, subject);

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={`${group.unit?.name ?? "unmapped"}-${group.chapters[0].n}`}>
          {/* Nothing at all for an unmapped run: CBSE's 2025-26 Class IX
              syllabus is written against the previous books, so a heading here
              would be a guess, and a guess about marks is worse than silence. */}
          {group.unit && (
            <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 px-1">
              <span className="text-xs font-semibold uppercase tracking-wide break-words text-ink-soft">
                {group.unit.name}
              </span>
              <span className="text-xs text-ink-faint">
                {group.continued
                  ? "continued"
                  : `${group.unit.marks} ${group.unit.marks === 1 ? "mark" : "marks"} in the board exam`}
              </span>
            </h3>
          )}

          <ul
            aria-label={
              group.unit
                ? `${group.unit.name} chapters`
                : `${book.title} chapters with no syllabus unit`
            }
            className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface"
          >
            {group.chapters.map((ch) => (
              // A two-row grid, not a single flex line: the title gets every
              // pixel from the chapter number to the right edge and wraps
              // instead of ellipsing, and the controls drop to a line of their
              // own where they have room to be 44px targets.
              //
              //   [ 7 ]  Human Eye and the Colourful World
              //          714 KB              [ Rate ] [ Save ]
              //          <rating panel, when open>
              <li
                key={ch.n}
                className="relative grid grid-cols-[2rem_1fr_auto_auto] items-center gap-x-2 gap-y-0 px-3 py-1.5 transition-colors focus-within:bg-surface-alt hover:bg-surface-alt"
              >
                <span className="col-start-1 row-start-1 grid size-8 place-items-center self-center rounded-lg bg-surface-alt text-xs font-semibold tabular-nums text-ink-soft">
                  {ch.n}
                </span>
                {/* `after:inset-0` stretches the hit area over the whole row —
                    including the size text — so reading the chapter is the easy
                    tap and the two buttons are the deliberate ones. */}
                <Link
                  href={`/read/${book.code}/${ch.n}`}
                  className="col-span-3 col-start-2 row-start-1 flex min-h-11 items-center text-sm leading-snug font-medium break-words after:absolute after:inset-0 after:content-['']"
                >
                  {ch.title}
                </Link>
                <span className="col-start-2 row-start-2 text-xs tabular-nums text-ink-faint">
                  {formatBytes(ch.bytes)}
                </span>
                <ChapterRating
                  className="col-start-3 row-start-2"
                  bookCode={book.code}
                  chapter={ch.n}
                  subject={subject}
                  classNum={book.class}
                />
                <DownloadButton
                  className="col-start-4 row-start-2"
                  showLabel
                  url={pdfPath(book.code, ch.file)}
                  bytes={ch.bytes}
                  label={`chapter ${ch.n}`}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
