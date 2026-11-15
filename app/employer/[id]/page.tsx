import { Suspense } from "react";
import { Loading } from "@/components/ui/states";
import { PacketClient } from "./packet-client";

export default function EmployerPacketPage() {
  return (
    <Suspense fallback={<Loading label="Loading the packet…" />}>
      <PacketClient />
    </Suspense>
  );
}
