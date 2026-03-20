import { Suspense } from "react";
import EditBookClient from "../books/[bookId]/edit/EditBookClient";
import { Spinner } from "@/components/ui/Spinner";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner className="w-8 h-8 text-indigo-600" /></div>}>
      <EditBookClient />
    </Suspense>
  );
}
