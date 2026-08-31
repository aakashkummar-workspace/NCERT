import AppHeader from "@/components/AppHeader";
import Hub from "@/components/Hub";

export const metadata = { title: "Everything — NCERT Quick" };

/**
 * Prerendered on purpose. `Hub` reads the session on the client, so this page
 * exists offline and still lists the eight things that work with no network.
 * A server-rendered version would know who you are sooner and be useless on a
 * train.
 */
export default function HubPage() {
  return (
    <>
      <AppHeader
        title="Everything"
        subtitle="Every part of the app, in one place"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <Hub />
      </main>
    </>
  );
}
