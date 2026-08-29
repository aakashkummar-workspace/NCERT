import AppHeader from "@/components/AppHeader";
import BookmarksList from "@/components/BookmarksList";

export const metadata = { title: "Bookmarks — NCERT Quick" };

export default function BookmarksPage() {
  return (
    <>
      <AppHeader
        title="Bookmarks"
        subtitle="Pages you saved on this device"
        back={{ href: "/", label: "home" }}
      />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <BookmarksList />
      </main>
    </>
  );
}
