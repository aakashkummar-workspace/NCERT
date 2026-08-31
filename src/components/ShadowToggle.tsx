"use client";

import { useSyncExternalStore } from "react";
import {
  SHADOW_PREF_EVENT,
  SHADOW_PREF_KEY,
  readShadowPreference,
  writeShadowPreference,
} from "@/lib/shadow";

/**
 * The Shadow Mode switch.
 *
 * ## The copy is the safety feature
 *
 * Two rules govern every word on this control.
 *
 * **It never implies the student should be hiding.** A 14-year-old reaches for
 * this because they are embarrassed to ask, and a label like "Ask
 * anonymously — nobody has to know it was you" agrees with them that not
 * knowing is important. So the label states a fact about who sees a name, and
 * stops.
 *
 * **It never overpromises.** The student is told, in the control itself and not
 * in a policy page they will not read, exactly where the anonymity ends: their
 * classmates do not see their name; their teacher and a moderator still can.
 * Anything vaguer is a promise the platform cannot keep, made to a child, about
 * something they may be about to write down. See src/lib/shadow.ts.
 */
/** `storage` for other tabs, the custom event for other components in this one. */
function subscribeToPreference(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === SHADOW_PREF_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SHADOW_PREF_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SHADOW_PREF_EVENT, onChange);
  };
}

export default function ShadowToggle({
  value,
  onChange,
  className = "",
}: {
  /** Controlled when provided; otherwise the stored preference. */
  value?: boolean;
  onChange?: (on: boolean) => void;
  className?: string;
}) {
  // `localStorage` is an external store, so it is read as one. The server
  // snapshot is `false`: a page rendered before the browser has been asked
  // shows the signed state, and never flashes "anonymous" at a student who
  // did not choose it.
  const stored = useSyncExternalStore(subscribeToPreference, readShadowPreference, () => false);
  const on = value ?? stored;

  function toggle() {
    const next = !on;
    // `writeShadowPreference` dispatches the event the subscription above
    // listens for, so there is nothing else to update — including in the other
    // copy of this control inside the reply composer.
    writeShadowPreference(next);
    onChange?.(next);
  }

  return (
    <div className={`rounded-xl border border-border bg-surface p-3 ${className}`}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={toggle}
        /* min-h-11 is 44px — the tap target the rest of the app uses. */
        className="flex min-h-11 w-full items-center gap-3 text-left"
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
            on ? "bg-accent" : "bg-border"
          }`}
        >
          <span
            className={`inline-block size-5 rounded-full bg-paper shadow transition-transform ${
              on ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Shadow Mode</span>
          <span className="block text-xs text-ink-faint">
            {on
              ? "Classmates see a nickname instead of your name."
              : "Your name shows on what you post."}
          </span>
        </span>
      </button>

      {on && (
        /* Stated every time it is on, not once at sign-up. A student deciding
           what to type needs the limit in front of them at that moment. */
        <p className="mt-2 border-t border-border pt-2 text-xs leading-relaxed text-ink-faint">
          Your teacher and the moderators can still see it was you. That is how we
          keep this place safe — it is not a place to say something you would not
          sign.
        </p>
      )}
    </div>
  );
}
