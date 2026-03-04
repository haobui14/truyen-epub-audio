import BookDetailClient from "./BookDetailClient";

export function generateStaticParams() {
  return [{ bookId: "placeholder" }];
}

export default function Page() {
  return <BookDetailClient />;
}
