"use client";

import { CLASSES, type ClassNum } from "@/lib/manifest";

/**
 * Switch which class the home screen shows.
 *
 * A two-state segmented control rather than a dropdown: there are exactly two
 * classes, so a menu would cost a tap and an overlay to say the same thing.
 * Controlled — the parent owns the value and is what persists it.
 *
 * min-h-11 is 44px, the tap-target floor scripts/smoke-mobile.mjs enforces. It
 * was 36px until the quiz index started rendering this on a screen a fresh
 * browser actually reaches: on home the switcher only appears once a class is
 * stored, which no audit run ever had.
 */
export default function ClassSwitcher({
  value,
  onChange,
}: {
  value: ClassNum;
  onChange: (cls: ClassNum) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Show subjects for"
      className="flex shrink-0 gap-0.5 rounded-full border border-border bg-surface p-0.5"
    >
      {CLASSES.map((cls) => {
        const active = cls === value;
        return (
          <button
            key={cls}
            type="button"
            onClick={() => onChange(cls)}
            aria-pressed={active}
            className={`min-h-11 rounded-full px-3.5 text-sm font-medium transition-colors ${
              active
                ? "bg-accent text-accent-ink"
                : "text-ink-soft hover:bg-surface-alt hover:text-ink"
            }`}
          >
            Class {cls}
          </button>
        );
      })}
    </div>
  );
}
