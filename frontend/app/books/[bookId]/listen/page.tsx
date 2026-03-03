import { Suspense } from "react";
import ListenPageClient from "./ListenPageClient";
import { Spinner } from "@/components/ui/Spinner";

export function generateStaticParams() {
  return [{ bookId: "placeholder" }];
}

export default function Page(props: { params: Promise<{ bookId: string }> }) {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner className="w-8 h-8 text-indigo-600" /></div>}>
      <ListenPageClient params={props.params} />
    </Suspense>
  );
}
