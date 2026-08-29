import AppHeader from "@/components/AppHeader";
import DownloadsManager from "@/components/DownloadsManager";

export const metadata = { title: "Offline downloads — NCERT Quick" };

export default function DownloadsPage() {
  return (
    <>
      <AppHeader
        title="Offline downloads"
        subtitle="Chapters saved on this device"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <DownloadsManager />
      </main>
    </>
  );
}
