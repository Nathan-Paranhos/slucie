import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SectionPage } from "@/components/section-page";
import { isSection } from "@/lib/types";

const names: Record<string, string> = {
  events: "Eventos",
  jobs: "Jobs",
  workers: "Workers",
  "dead-letter": "Dead-letter",
  tenants: "Tenants",
  metrics: "Métricas",
  sources: "Fontes",
  destinations: "Destinos",
  pipelines: "Pipelines",
  settings: "Configurações"
};

export async function generateMetadata({
  params
}: {
  params: Promise<{ section: string }>;
}): Promise<Metadata> {
  const resolvedParams = await params;
  return {
    title: names[resolvedParams.section] ?? "Console"
  };
}

export default async function DynamicSectionPage({
  params
}: {
  params: Promise<{ section: string }>;
}) {
  const resolvedParams = await params;
  if (
    !isSection(resolvedParams.section) ||
    resolvedParams.section === "overview"
  ) {
    notFound();
  }

  return <SectionPage section={resolvedParams.section} />;
}
