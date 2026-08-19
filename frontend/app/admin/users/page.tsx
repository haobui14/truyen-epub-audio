import { Suspense } from "react";
import UsersClient from "./UsersClient";
import { Spinner } from "@/components/ui/Spinner";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-24">
          <Spinner className="w-8 h-8 text-accent" />
        </div>
      }
    >
      <UsersClient />
    </Suspense>
  );
}
