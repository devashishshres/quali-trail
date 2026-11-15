import { Suspense } from "react";
import { Loading } from "@/components/ui/states";
import { ReviewClient } from "./review-client";

export default function ReviewPage() {
  return (
    <Suspense fallback={<Loading label="Loading the request…" />}>
      <ReviewClient />
    </Suspense>
  );
}
