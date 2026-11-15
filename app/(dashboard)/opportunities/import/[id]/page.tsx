import { Suspense } from "react";
import { Loading } from "@/components/ui/states";
import { ImportReviewClient } from "./import-client";

export default function ImportReviewPage() {
  return (
    <Suspense fallback={<Loading label="Loading the draft…" />}>
      <ImportReviewClient />
    </Suspense>
  );
}
