import { Suspense } from "react";
import ReadPageClient from "../books/[bookId]/read/ReadPageClient";
import { Spinner } from "@/components/ui/Spinner";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner className="w-8 h-8 text-indigo-600" /></div>}>
      <ReadPageClient />
    </Suspense>
  );
}
