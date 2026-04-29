import { Suspense } from "react";
import SearchClient from "./SearchClient";
import { Spinner } from "@/components/ui/Spinner";

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-24">
          <Spinner className="w-8 h-8 text-accent" />
        </div>
      }
    >
      <SearchClient />
    </Suspense>
  );
}
