import { Suspense } from "react";
import EditChapterClient from "../books/[bookId]/chapters/[chapterId]/EditChapterClient";
import { Spinner } from "@/components/ui/Spinner";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner className="w-8 h-8 text-indigo-600" /></div>}>
      <EditChapterClient />
    </Suspense>
  );
}
