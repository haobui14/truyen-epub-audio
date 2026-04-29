import { Suspense } from "react";
import EditChapterClient from "./EditChapterClient";
import { Spinner } from "@/components/ui/Spinner";

export function generateStaticParams() {
  return [{ bookId: "placeholder", chapterId: "placeholder" }];
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner className="w-8 h-8 text-accent" /></div>}>
      <EditChapterClient />
    </Suspense>
  );
}
