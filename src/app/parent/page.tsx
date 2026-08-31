import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import ConsentGate from "@/components/ConsentGate";
import ParentDashboard from "@/components/ParentDashboard";
import { getSession } from "@/lib/session";

export const metadata = { title: "At home — NCERT Quick" };

/**
 * One URL for both halves of the same relationship.
 *
 * A parent lands here and sees the dashboard; a student lands here and sees who
 * has asked to follow them, what they would see, and a button that stops it.
 * They are the same screen because they are the same subject — and because a
 * student told "your father can see /parent" should be able to open /parent
 * themselves and find out exactly what that means.
 *
 * `getSession()` rather than `requireUser()`: this reads the cookie only, with
 * no database round trip, and the role it returns decides nothing but which
 * panel renders. Both panels get their data from routes that re-read the role
 * from the `users` row (docs/PLATFORM.md §1), so a stale cookie claiming
 * `PARENT` renders an empty dashboard rather than somebody's marks.
 *
 * `/parent` is not in `TabBar`, which belongs to another lane. A parent reaches
 * it from the link they are sent; adding the tab entry for students is a
 * one-line change for whoever owns that file.
 */
export default async function ParentPage() {
  const session = await getSession();

  return (
    <>
      <AppHeader
        title="At home"
        subtitle={
          session?.role === "PARENT" ? "Progress a family can act on" : "Who can follow your progress"
        }
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {!session && (
          <div className="rounded-2xl border border-dashed border-border p-5">
            <p className="text-sm text-ink-soft">
              Sign in to see who can follow your progress, or to follow your child&apos;s.
            </p>
            <Link
              href="/"
              className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm text-accent transition-colors hover:border-accent"
            >
              Back to your books
            </Link>
          </div>
        )}
        {session?.role === "PARENT" && <ParentDashboard />}
        {session && session.role !== "PARENT" && <ConsentGate />}
      </main>
    </>
  );
}
