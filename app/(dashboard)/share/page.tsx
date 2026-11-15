"use client";
import { EmployerSharePanel } from "@/components/employer/share-panel";
import { PageHeader } from "@/components/ui/states";

export default function SharePage() {
  return (
    <>
      <PageHeader
        title="Share with an employer"
        lede="Send one person a read-only copy of confirmed work and certifications you choose. You see it first, it expires, and you can withdraw it at any time."
      />
      <EmployerSharePanel />
    </>
  );
}
