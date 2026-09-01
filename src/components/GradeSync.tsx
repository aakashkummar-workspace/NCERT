"use client";

import { useEffect, useRef, useState } from "react";
import { syncPending, type SyncOutcome } from "@/lib/handoff-sync";

/**
 * The poll that lets a teacher's mark reach `/revise`.
 *
 * A dual-track sitting is finished on the device and the written half is marked
 * somewhere else entirely — by a rubric, or by a human, hours or days later.
 * Nothing pushes that mark back: there is no socket, no web push, and a phone
 * on 2G is not somewhere to open one. So the device asks, on the two screens
 * where the answer matters — the results of a sitting, and the revision queue
 * the marks feed.
 *
 * ## An honest cadence
 *
 * Once on mount, then **every two minutes while something is actually
 * outstanding**, and it stops the moment nothing is. A mark takes a human
 * minutes at best; a tighter poll would burn a battery to shave nothing off a
 * wait measured in hours. When `pending` reaches zero there is nothing left to
 * ask about and the timer is cleared rather than left ticking against an
 * unchanging answer. Remounting the screen asks once more, which is what a
 * student refreshing the page means by refreshing the page.
 *
 * It renders nothing at all until something lands, and it never renders an
 * error: a failed sync is "not now", and telling a student their marks failed
 * to arrive when nobody has awarded any is worse than silence.
 */
const EVERY_MS = 2 * 60 * 1000;

export default function GradeSync({ onGraded }: { onGraded?: () => void }) {
  const [landed, setLanded] = useState<SyncOutcome | null>(null);

  /* Held in a ref so an inline `onGraded` from the parent cannot restart the
     poll on every render — which would be a new timer per keystroke upstream. */
  const notify = useRef(onGraded);
  useEffect(() => {
    notify.current = onGraded;
  }, [onGraded]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /*
     * `.then` with a `live` guard rather than an async effect body: this
     * component is mounted on a screen a student leaves quickly, and a resolve
     * after unmount must be a no-op rather than a state update on a dead tree.
     * The same shape as RevisionQueue, for the same reason.
     */
    const run = () => {
      syncPending()
        .then((outcome) => {
          if (!live) return;
          if (outcome.attached > 0) {
            setLanded(outcome);
            notify.current?.();
          }
          // Nothing outstanding: stop asking. This is the whole of the stop
          // condition, and it is why the poll is not a leak.
          if (outcome.pending > 0) timer = setTimeout(run, EVERY_MS);
        })
        .catch(() => {
          // syncPending swallows its own failures; this is belt and braces.
          if (live) timer = setTimeout(run, EVERY_MS);
        });
    };
    run();

    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!landed) return null;

  return (
    <p
      role="status"
      className="rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-xs text-ink"
    >
      {landed.attached === 1
        ? "A marked answer came back and has been folded into your revision schedule."
        : `${landed.attached} marked answers came back and have been folded into your revision schedule.`}
    </p>
  );
}
