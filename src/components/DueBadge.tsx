"use client";

import { useEffect, useState } from "react";
import { dueCount } from "@/lib/revision";

/**
 * How many revision cards are waiting. Renders nothing at zero, so the home
 * screen stays quiet for a student with nothing to revise.
 */
export default function DueBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    dueCount()
      .then(setCount)
      .catch(() => setCount(0));
  }, []);

  if (count === 0) return null;

  return (
    <span
      aria-label={`${count} due`}
      className="ml-1.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-accent-ink"
    >
      {count}
    </span>
  );
}
