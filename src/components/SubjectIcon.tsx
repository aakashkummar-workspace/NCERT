/** Simple line glyphs per subject; falls back to a book for anything unmapped. */
const PATHS: Record<string, string> = {
  science: "M9 3v6l-5 9a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3l-5-9V3M8 3h8M7.5 14h9",
  mathematics: "M5 5h14M5 12h6M5 19h6M15 10v8M11 14h8",
  "social-science": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z",
  english: "M4 5h16M4 5v14M20 5v14M4 19h16M9 9h6M9 13h6",
  hindi: "M4 6h16M8 6v12M14 6v12M4 12h16",
};

const FALLBACK = "M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2V5ZM8 3v18";

export default function SubjectIcon({ slug, className }: { slug: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d={PATHS[slug] ?? FALLBACK}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
