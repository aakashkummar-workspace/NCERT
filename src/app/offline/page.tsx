import Link from "next/link";

export const metadata = { title: "Offline — NCERT Quick" };

/** Shown by the service worker when a page is requested with no network. */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-lg font-semibold">You are offline</h1>
      <p className="mt-2 text-sm text-ink-soft">
        This page has not been opened before, so there is no saved copy on this device.
      </p>
      <Link
        href="/downloads"
        className="mt-6 rounded-lg border border-border px-4 py-2 text-sm text-accent"
      >
        See downloaded chapters
      </Link>
    </main>
  );
}
