"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import DueBadge from "./DueBadge";

/**
 * The app's persistent navigation.
 *
 * Four destinations, thumb-reachable, on every screen but the reader: a chapter
 * is full-bleed reading and already carries its own bottom toolbar, and two
 * stacked bars would eat a third of a small phone's screen.
 *
 * The bar is `fixed`, so it is out of flow and would otherwise sit on top of
 * the last few lines of every page. Rather than ask each page to remember its
 * own bottom padding, this component also renders a spacer in the flow. Both
 * appear and disappear together, which is exactly the behaviour wanted.
 */

interface Tab {
  href: string;
  label: string;
  /** Icon path data, drawn on a 24×24 grid with `currentColor`. */
  d: string;
  /** Sections that count as "you are here" beyond the tab's own route. */
  extra?: string[];
  badge?: boolean;
}

const TABS: Tab[] = [
  {
    href: "/",
    label: "Study",
    d: "M12 6.6C10.4 5.1 8.1 4.5 5 4.5v13c3.1 0 5.4.6 7 2 1.6-1.4 3.9-2 7-2v-13c-3.1 0-5.4.6-7 2.1Zm0 0V19.5",
    // Subject and book lists live under /class/… but are still "Study".
    extra: ["/class", "/bookmarks", "/downloads"],
  },
  {
    href: "/practice",
    label: "Practice",
    d: "M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Zm0 0v4h4M9.5 13.5h5M9.5 17h3",
    // Quizzes are the short form of the same thing a sample paper is, so they
    // keep this tab lit rather than earning a fifth one — five tabs on a 390px
    // phone is where labels start truncating.
    extra: ["/quiz"],
  },
  {
    href: "/revise",
    label: "Revise",
    d: "M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 3.5v4.2h-4.2",
    badge: true,
  },
  {
    href: "/progress",
    label: "Progress",
    d: "M4 20h16M7 20v-6M12 20V6M17 20v-9",
  },
];

/** Static export uses trailing slashes; compare on a normalised path. */
function normalise(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isActive(tab: Tab, path: string): boolean {
  const own = [tab.href, ...(tab.extra ?? [])];
  return own.some((base) =>
    base === "/" ? path === "/" : path === base || path.startsWith(`${base}/`),
  );
}

export default function TabBar() {
  const path = normalise(usePathname());

  // The reader owns the bottom of the screen.
  if (path === "/read" || path.startsWith("/read/")) return null;

  return (
    <>
      <div className="tab-bar-spacer" aria-hidden="true" />

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        <ul className="mx-auto flex max-w-3xl">
          {TABS.map((tab) => {
            const active = isActive(tab, path);
            return (
              <li key={tab.href} className="min-w-0 flex-1">
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex min-h-[var(--tab-bar-h)] flex-col items-center justify-center gap-1 px-1 py-1.5 transition-colors ${
                    active ? "text-accent" : "text-ink-faint hover:text-ink-soft"
                  }`}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-3 top-0 h-0.5 rounded-b-full bg-accent"
                    />
                  )}
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    className="shrink-0"
                  >
                    <path
                      d={tab.d}
                      stroke="currentColor"
                      strokeWidth={active ? 2 : 1.6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span
                    className={`flex items-center text-[11px] leading-none ${
                      active ? "font-semibold" : "font-medium"
                    }`}
                  >
                    {tab.label}
                    {tab.badge && <DueBadge />}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
