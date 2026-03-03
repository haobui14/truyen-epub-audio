import { Suspense } from "react";
import ReadPageClient from "./ReadPageClient";
import { Spinner } from "@/components/ui/Spinner";

export function generateStaticParams() {
  return [{ bookId: "placeholder" }];
}

export default function Page(props: { params: Promise<{ bookId: string }> }) {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner className="w-8 h-8 text-indigo-600" /></div>}>
      <ReadPageClient params={props.params} />
    </Suspense>
  );
}
