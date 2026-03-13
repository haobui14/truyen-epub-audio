import EditChapterClient from "./EditChapterClient";

export function generateStaticParams() {
  return [{ bookId: "placeholder", chapterId: "placeholder" }];
}

export default function Page() {
  return <EditChapterClient />;
}
