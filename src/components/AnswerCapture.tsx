"use client";

/**
 * Photograph a handwritten answer script, page by page, and hand it to the
 * grader.
 *
 * **Rejecting a blurry page before it is uploaded is worth more than any amount
 * of model tuning.** A photograph the model cannot read produces a low mark and
 * a confident-sounding reason for it, and the student has no way to tell that
 * from a genuine one. So every page is measured the moment it is taken — sharp
 * enough, bright enough, big enough — and a page that fails is shown as a
 * problem the student can fix in five seconds by re-shooting it, while the
 * script is still in front of them. Nothing here blocks an upload: a warning a
 * student cannot override is a student who cannot submit at all when the light
 * in the room is bad, which is worse.
 *
 * ## The upload
 *
 * Four calls, in this order, and every one of them survives a retry:
 *
 *   POST /api/submissions/            create   (one Idempotency-Key, reused)
 *   POST /api/submissions/{id}/pages/ per page (unique on submission+index)
 *   POST /api/submissions/{id}/answers/ which pages hold which question
 *   POST /api/submissions/{id}/submit/  join the queue (Idempotency-Key)
 *
 * The key is generated once, when the student first presses Upload, and kept
 * for the life of the component. Indian mobile networks drop and retry POSTs
 * freely, and a student who ends up with two copies of one answer sheet is
 * charged twice and shown two contradictory grades.
 *
 * The bytes go through our own route rather than to a pre-signed URL, because
 * content type, size and sha256 are pinned server-side and there is no
 * parameter to pass them in — see the note in the pages route.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type QuestionType = "mcq" | "assertion-reason" | "vsa" | "sa" | "la" | "case-study";

interface Shot {
  /** Stable for the life of this capture, so reordering never moves a file. */
  id: string;
  file: File;
  url: string;
  width: number;
  height: number;
  /** Variance of the Laplacian. Higher is sharper; under ~120 reads as blur. */
  sharpness: number;
  /** Mean luminance, 0-255. */
  brightness: number;
}

interface Declared {
  id: string;
  questionNumber: number;
  maxMarks: number;
  type: QuestionType;
  /** Shot ids, in reading order. */
  shotIds: string[];
}

/** Below this the handwriting will not survive the model's own downscale. */
const MIN_SHARPNESS = 120;
const MIN_BRIGHTNESS = 45;
const MAX_BRIGHTNESS = 235;
const MIN_LONG_EDGE = 900;

const TYPES: { value: QuestionType; label: string }[] = [
  { value: "vsa", label: "Very short" },
  { value: "sa", label: "Short" },
  { value: "la", label: "Long" },
  { value: "case-study", label: "Case study" },
  { value: "assertion-reason", label: "Assertion–reason" },
  { value: "mcq", label: "MCQ" },
];

/**
 * How readable this photograph is, measured rather than guessed.
 *
 * Variance of the Laplacian on a downscaled greyscale copy — the standard
 * cheap sharpness estimate, and cheap matters: this runs on a mid-range Android
 * once per page, between the shutter and the review screen.
 */
async function measure(file: File): Promise<{ width: number; height: number; sharpness: number; brightness: number }> {
  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;

  const scale = Math.min(1, 480 / Math.max(width, height));
  const w = Math.max(8, Math.round(width * scale));
  const h = Math.max(8, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return { width, height, sharpness: Number.POSITIVE_INFINITY, brightness: 128 };
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, w, h);

  const grey = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    grey[i] = v;
    sum += v;
  }
  const brightness = sum / (w * h);

  let lapSum = 0;
  let lapSqSum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = grey[i - 1] + grey[i + 1] + grey[i - w] + grey[i + w] - 4 * grey[i];
      lapSum += lap;
      lapSqSum += lap * lap;
      n++;
    }
  }
  const mean = n ? lapSum / n : 0;
  const sharpness = n ? lapSqSum / n - mean * mean : 0;
  return { width, height, sharpness, brightness };
}

function problemWith(shot: Shot): string | null {
  if (Math.max(shot.width, shot.height) < MIN_LONG_EDGE) {
    return "This photo is small — the handwriting may not survive. Shoot it closer.";
  }
  if (shot.brightness < MIN_BRIGHTNESS) return "Too dark to read. Find more light and retake.";
  if (shot.brightness > MAX_BRIGHTNESS) return "Washed out by glare. Tilt the page away from the light.";
  if (shot.sharpness < MIN_SHARPNESS) return "This looks blurry. Hold still and retake.";
  return null;
}

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

export interface AnswerCaptureProps {
  /** The paper these answers belong to, when the student came from one. */
  paperSlug?: string;
  subject?: string;
  classNum?: 9 | 10;
  /** Called with the new submission id once it is queued. */
  onSubmitted?: (submissionId: string) => void;
}

export default function AnswerCapture({
  paperSlug,
  subject: initialSubject = "Science",
  classNum: initialClass = 10,
  onSubmitted,
}: AnswerCaptureProps) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [declared, setDeclared] = useState<Declared[]>([]);
  const [subject, setSubject] = useState(initialSubject);
  const [classNum, setClassNum] = useState<9 | 10>(initialClass);
  const [slug, setSlug] = useState(paperSlug ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ submissionId: string; queued: boolean; configured: boolean } | null>(null);

  const shutter = useRef<HTMLInputElement>(null);
  const retakeFor = useRef<string | null>(null);
  // One key for the life of this capture. Regenerating it on retry is the bug
  // idempotency exists to prevent.
  const idempotencyKey = useRef<string>(uid());

  // Object URLs outlive the component unless they are revoked, and a script is
  // a dozen 4 MB photographs.
  useEffect(() => {
    return () => {
      for (const shot of shots) URL.revokeObjectURL(shot.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback(async (files: FileList) => {
    const replacing = retakeFor.current;
    retakeFor.current = null;
    const taken: Shot[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const stats = await measure(file);
      taken.push({ id: uid(), file, url: URL.createObjectURL(file), ...stats });
    }
    if (!taken.length) return;

    setShots((current) => {
      if (replacing) {
        const old = current.find((s) => s.id === replacing);
        if (old) URL.revokeObjectURL(old.url);
        // Keep the id, so a page already assigned to a question stays assigned.
        return current.map((s) => (s.id === replacing ? { ...taken[0], id: replacing } : s));
      }
      return [...current, ...taken];
    });
  }, []);

  const move = (id: string, by: number) =>
    setShots((current) => {
      const i = current.findIndex((s) => s.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= current.length) return current;
      const next = [...current];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const remove = (id: string) => {
    setShots((current) => {
      const gone = current.find((s) => s.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return current.filter((s) => s.id !== id);
    });
    setDeclared((current) =>
      current.map((d) => ({ ...d, shotIds: d.shotIds.filter((sid) => sid !== id) })),
    );
  };

  const addQuestion = () =>
    setDeclared((current) => [
      ...current,
      {
        id: uid(),
        questionNumber: (current[current.length - 1]?.questionNumber ?? 0) + 1,
        maxMarks: 3,
        type: "sa",
        shotIds: current.length ? [] : shots.map((s) => s.id),
      },
    ]);

  const patch = (id: string, change: Partial<Declared>) =>
    setDeclared((current) => current.map((d) => (d.id === id ? { ...d, ...change } : d)));

  const togglePage = (questionId: string, shotId: string) =>
    setDeclared((current) =>
      current.map((d) =>
        d.id === questionId
          ? {
              ...d,
              shotIds: d.shotIds.includes(shotId)
                ? d.shotIds.filter((s) => s !== shotId)
                : // Reading order is the order the pages are in, not the order
                  // they were tapped.
                  shots.filter((s) => d.shotIds.includes(s.id) || s.id === shotId).map((s) => s.id),
            }
          : d,
      ),
    );

  async function upload() {
    setError(null);
    if (!shots.length) return setError("Take at least one photograph first.");
    const answers = declared.filter((d) => d.shotIds.length);
    if (!answers.length) {
      return setError("Say which pages hold which question before uploading.");
    }
    const numbers = new Set(answers.map((a) => a.questionNumber));
    if (numbers.size !== answers.length) {
      return setError("Two questions have the same number. Each one may only be listed once.");
    }

    try {
      setBusy("Creating the submission…");
      const created = await postJson("/api/submissions/", {
        paperSlug: slug || undefined,
        subject,
        classNum,
        pageCount: shots.length,
        capturedAt: new Date().toISOString(),
      }, idempotencyKey.current);
      const submissionId: string = created.submissionId;

      const indexById = new Map(shots.map((s, i) => [s.id, i]));
      for (const [i, shot] of shots.entries()) {
        setBusy(`Uploading page ${i + 1} of ${shots.length}…`);
        const form = new FormData();
        form.append("file", shot.file);
        form.append("pageIndex", String(i));
        // Re-uploading the same index replaces it, so a retake after a failed
        // upload does not leave the first attempt behind.
        form.append("replace", "true");
        const res = await fetch(`/api/submissions/${submissionId}/pages/`, { method: "POST", body: form });
        if (!res.ok) throw new Error(await messageOf(res));
      }

      setBusy("Saying which pages hold which question…");
      await postJson(`/api/submissions/${submissionId}/answers/`, {
        answers: answers.map((a) => ({
          questionNumber: a.questionNumber,
          maxMarks: a.maxMarks,
          type: a.type,
          pageIndexes: a.shotIds.map((sid) => indexById.get(sid) as number),
        })),
      });

      setBusy("Joining the queue…");
      const submitted = await postJson(
        `/api/submissions/${submissionId}/submit/`,
        {},
        `${idempotencyKey.current}:submit`,
      );

      setDone({
        submissionId,
        queued: Boolean(submitted.queued),
        configured: Boolean(submitted.gradingConfigured),
      });
      onSubmitted?.(submissionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-lg font-semibold">Your script is in.</h2>
        <p className="mt-2 text-sm text-ink-soft">
          {done.configured
            ? "It is queued for marking. You will see the marks on the results screen when they land."
            : // Said plainly. A queue with no grader behind it is still a queue,
              // and a student is owed the difference between "waiting" and
              // "marked".
              "It is queued, but no marker is configured on this deployment yet, so nothing has been marked. Nothing has been guessed at either."}
        </p>
        <a
          className="mt-4 inline-flex min-h-12 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-ink"
          href={`/results/${done.submissionId}/`}
        >
          See this script
        </a>
      </section>
    );
  }

  const flagged = shots.filter((s) => problemWith(s)).length;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <input
          ref={shutter}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="min-h-12 w-full rounded-md bg-accent px-4 text-sm font-medium text-accent-ink"
          onClick={() => shutter.current?.click()}
        >
          {shots.length ? "Add another page" : "Photograph the first page"}
        </button>
        <p className="mt-2 text-xs text-ink-faint">
          One photograph per side of paper, in the order you wrote them. Flat page, no shadow across
          the writing, all four corners in frame.
        </p>
      </section>

      {shots.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">
            {shots.length} page{shots.length === 1 ? "" : "s"}
            {flagged > 0 && (
              <span className="ml-2 font-normal text-accent">
                {flagged} worth retaking
              </span>
            )}
          </h2>
          <ul className="mt-3 flex flex-col gap-3">
            {shots.map((shot, i) => {
              const problem = problemWith(shot);
              return (
                <li
                  key={shot.id}
                  className="flex gap-3 rounded-lg border border-border bg-surface p-3"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={shot.url}
                    alt={`Page ${i + 1}`}
                    className="h-24 w-20 shrink-0 rounded object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Page {i + 1}</p>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {shot.width}×{shot.height}
                    </p>
                    {problem ? (
                      <p className="mt-1 text-xs text-accent">{problem}</p>
                    ) : (
                      <p className="mt-1 text-xs text-ink-faint">Sharp and readable.</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="min-h-12 rounded-md border border-border px-3 text-xs"
                        onClick={() => {
                          retakeFor.current = shot.id;
                          shutter.current?.click();
                        }}
                      >
                        Retake
                      </button>
                      <button
                        type="button"
                        className="min-h-12 rounded-md border border-border px-3 text-xs disabled:opacity-40"
                        disabled={i === 0}
                        onClick={() => move(shot.id, -1)}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        className="min-h-12 rounded-md border border-border px-3 text-xs disabled:opacity-40"
                        disabled={i === shots.length - 1}
                        onClick={() => move(shot.id, 1)}
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        className="min-h-12 rounded-md border border-border px-3 text-xs text-accent"
                        onClick={() => remove(shot.id)}
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {shots.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">Which pages hold which question</h2>
          <p className="mt-1 text-xs text-ink-faint">
            Use the number the paper prints. One question can run across two pages, and one page can
            hold the end of one question and the start of the next — tick every page a question
            appears on.
          </p>

          <div className="mt-3 flex flex-col gap-3">
            {declared.map((d) => (
              <div key={d.id} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs text-ink-soft">
                    Question
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={d.questionNumber}
                      onChange={(e) => patch(d.id, { questionNumber: Number(e.target.value) })}
                      className="mt-1 block h-12 w-20 rounded-md border border-border bg-paper px-2 text-base text-ink"
                    />
                  </label>
                  <label className="text-xs text-ink-soft">
                    Out of
                    <input
                      type="number"
                      min={0.5}
                      max={30}
                      step={0.5}
                      value={d.maxMarks}
                      onChange={(e) => patch(d.id, { maxMarks: Number(e.target.value) })}
                      className="mt-1 block h-12 w-20 rounded-md border border-border bg-paper px-2 text-base text-ink"
                    />
                  </label>
                  <label className="text-xs text-ink-soft">
                    Kind
                    <select
                      value={d.type}
                      onChange={(e) => patch(d.id, { type: e.target.value as QuestionType })}
                      className="mt-1 block h-12 rounded-md border border-border bg-paper px-2 text-base text-ink"
                    >
                      {TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="ml-auto min-h-12 rounded-md border border-border px-3 text-xs text-accent"
                    onClick={() => setDeclared((c) => c.filter((x) => x.id !== d.id))}
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {shots.map((shot, i) => (
                    <button
                      key={shot.id}
                      type="button"
                      aria-pressed={d.shotIds.includes(shot.id)}
                      onClick={() => togglePage(d.id, shot.id)}
                      className={`min-h-12 rounded-md border px-3 text-xs ${
                        d.shotIds.includes(shot.id)
                          ? "border-accent bg-accent-soft text-ink"
                          : "border-border text-ink-soft"
                      }`}
                    >
                      Page {i + 1}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="mt-3 min-h-12 w-full rounded-md border border-border px-4 text-sm"
            onClick={addQuestion}
          >
            Add a question
          </button>
        </section>
      )}

      <section className="rounded-lg border border-border bg-surface p-3">
        <h2 className="text-sm font-semibold">Which paper</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-soft">
            Paper slug
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="class10-science-2025-26"
              className="mt-1 block h-12 w-64 max-w-full rounded-md border border-border bg-paper px-2 text-base text-ink"
            />
          </label>
          <label className="text-xs text-ink-soft">
            Subject
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-1 block h-12 w-40 rounded-md border border-border bg-paper px-2 text-base text-ink"
            />
          </label>
          <label className="text-xs text-ink-soft">
            Class
            <select
              value={classNum}
              onChange={(e) => setClassNum(Number(e.target.value) as 9 | 10)}
              className="mt-1 block h-12 rounded-md border border-border bg-paper px-2 text-base text-ink"
            >
              <option value={9}>9</option>
              <option value={10}>10</option>
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          The paper is how a marking scheme is found. Without it the pages are stored and read back,
          but nothing can be marked against a rubric.
        </p>
      </section>

      {error && (
        <p role="alert" className="rounded-md bg-accent-soft p-3 text-sm text-ink">
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={Boolean(busy) || !shots.length}
        className="min-h-12 w-full rounded-md bg-accent px-4 text-sm font-medium text-accent-ink disabled:opacity-50"
        onClick={() => void upload()}
      >
        {busy ?? "Upload and mark"}
      </button>
    </div>
  );
}

async function messageOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

async function postJson(
  url: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Record<string, never> & Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await messageOf(res));
  return res.json();
}
