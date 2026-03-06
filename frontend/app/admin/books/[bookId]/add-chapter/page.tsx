import AddChapterClient from "./AddChapterClient";

export function generateStaticParams() {
  return [{ bookId: "placeholder" }];
}

export default function Page() {
  return <AddChapterClient />;
}

