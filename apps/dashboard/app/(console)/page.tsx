import type { Metadata } from "next";
import { SectionPage } from "@/components/section-page";

export const metadata: Metadata = {
  title: "Visão geral"
};

export default function OverviewPage() {
  return <SectionPage section="overview" />;
}
