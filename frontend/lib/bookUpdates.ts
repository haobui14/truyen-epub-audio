import type { Book } from "@/types";

/** The API records this timestamp only after an actual chapter addition. */
export function getRecentlyUpdatedBooks(books: Book[]): Book[] {
  return books
    .filter(
      (book) =>
        book.total_chapters > 0 &&
        book.last_chapter_added_at &&
        Number.isFinite(Date.parse(book.last_chapter_added_at)),
    )
    .sort(
      (a, b) =>
        Date.parse(b.last_chapter_added_at!) -
        Date.parse(a.last_chapter_added_at!),
    );
}
