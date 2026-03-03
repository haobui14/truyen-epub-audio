import BookDetailClient from "./BookDetailClient";

export function generateStaticParams() {
  return [{ bookId: "placeholder" }];
}

export default function Page(props: { params: Promise<{ bookId: string }> }) {
  return <BookDetailClient params={props.params} />;
}
