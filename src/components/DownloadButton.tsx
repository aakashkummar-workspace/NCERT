"use client";

import { useEffect, useState } from "react";
import {
  deleteChapter,
  downloadChapter,
  isDownloaded,
  requestPersistence,
} from "@/lib/offline";
import { formatBytes } from "@/lib/manifest";

type State = "checking" | "absent" | "downloading" | "present" | "error";

/**
 * Per-chapter offline toggle. Chapters run to ~17 MB, so downloading is always
 * an explicit choice and progress is shown as it streams in.
 *
 * Two shapes, both 44px tall: a bare square for grids of icons (the practice
 * papers, where an outside caption already says what the file is), and a
 * labelled pill for the chapter list, where the word carries the meaning.
 */
export default function DownloadButton({
  url,
  bytes,
  label,
  showLabel = false,
  className = "",
}: {
  url: string;
  bytes?: number;
  label: string;
  /** Render the state as a word beside the icon. */
  showLabel?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<State>("checking");
  const [pct, setPct] = useState(0);

  useEffect(() => {
    let live = true;
    isDownloaded(url)
      .then((has) => live && setState(has ? "present" : "absent"))
      .catch(() => live && setState("absent"));
    return () => {
      live = false;
    };
  }, [url]);

  async function onClick(e: React.MouseEvent) {
    // The button sits over the row's link to the chapter; don't navigate.
    e.preventDefault();
    e.stopPropagation();

    if (state === "present") {
      await deleteChapter(url);
      setState("absent");
      return;
    }
    if (state === "downloading" || state === "checking") return;

    setState("downloading");
    setPct(0);
    try {
      await requestPersistence();
      await downloadChapter(url, ({ received, total }) =>
        setPct(Math.round((received / total) * 100)),
      );
      setState("present");
    } catch {
      setState("error");
    }
  }

  const title =
    state === "present"
      ? `Remove downloaded ${label}`
      : `Download ${label} for offline reading${bytes ? ` (${formatBytes(bytes)})` : ""}`;

  const word =
    state === "downloading"
      ? `${pct}%`
      : state === "present"
        ? "Saved"
        : state === "error"
          ? "Retry"
          : "Save";

  const icon =
    state === "present" ? (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M20 6 9 17l-5-5"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ) : (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );

  return (
    // `relative z-10` keeps the button above the chapter row's stretched link.
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={state === "present"}
      className={`relative z-10 shrink-0 rounded-lg border text-xs font-medium transition-colors hover:border-accent/50 hover:text-accent ${
        state === "present" ? "border-accent/40 text-accent" : "border-border text-ink-soft"
      } ${
        showLabel
          ? "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 px-2.5"
          : "grid size-11 place-items-center"
      } ${className}`}
    >
      {showLabel ? (
        <>
          {icon}
          <span aria-hidden="true">{word}</span>
        </>
      ) : state === "downloading" ? (
        <span className="tabular-nums text-accent">{pct}%</span>
      ) : state === "error" ? (
        <span className="text-accent">retry</span>
      ) : (
        icon
      )}
    </button>
  );
}
