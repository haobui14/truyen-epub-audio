import { Suspense } from "react";
import ReadPageClient from "../books/[bookId]/read/ReadPageClient";
import { Spinner } from "@/components/ui/Spinner";
import { RequireApproved } from "@/components/auth/RequireApproved";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner className="w-8 h-8 text-accent" /></div>}>
      <RequireApproved>
        <ReadPageClient />
      </RequireApproved>
    </Suspense>
  );
}
