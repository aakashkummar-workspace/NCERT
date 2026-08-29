import Link from "next/link";

/** Shared top bar. `back` renders a chevron link; omit it on the home screen. */
export default function AppHeader({
  title,
  subtitle,
  back,
}: {
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-paper/85 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        {back && (
          <Link
            href={back.href}
            aria-label={`Back to ${back.label}`}
            /* size-11 is 44px — the minimum comfortable tap target. The negative
               margin keeps the chevron optically aligned with the page gutter
               even though its hit area is larger than the glyph. */
            className="-ml-2.5 grid size-11 shrink-0 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-surface-alt hover:text-ink"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M15 18l-6-6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        )}
        <div className="min-w-0">
          {/* Chapter titles are long ("Magnetic Effects of Electric Current") and
              are the reason the screen exists, so let them wrap to two lines
              rather than ellipsing. The subtitle is genuinely secondary and can
              still truncate. */}
          <h1 className="line-clamp-2 text-base font-semibold leading-tight">{title}</h1>
          {subtitle && <p className="truncate text-xs text-ink-faint">{subtitle}</p>}
        </div>
      </div>
    </header>
  );
}
