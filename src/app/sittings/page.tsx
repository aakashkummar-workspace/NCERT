import AppHeader from "@/components/AppHeader";
import SittingsList from "./SittingsList";

export const metadata = { title: "Papers you have sat — NCERT Quick" };

/**
 * The history of every paper this account has sat, from both flows.
 *
 * Statically generated, like every other shell in the app: the page is a header
 * and a heading, and the list underneath is a client fetch against
 * `GET /api/attempts/` behind the session cookie. Nothing here is per-student,
 * so nothing here needs a server render.
 */
export default function SittingsPage() {
  return (
    <>
      <AppHeader
        title="Papers you have sat"
        subtitle="Every sitting, and what happened to it"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <SittingsList />
      </main>
    </>
  );
}
