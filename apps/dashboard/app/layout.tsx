import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap"
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-interface",
  display: "swap"
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata: Metadata = {
  title: {
    default: "Sluice — Fluxo confiável",
    template: "%s · Sluice"
  },
  description:
    "Plataforma open source, multi-tenant e LGPD-native para ingestão segura de webhooks e execução confiável de jobs.",
  applicationName: "Sluice",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg"
  }
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0d0d0d",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="pt-BR"
      className={`${manrope.variable} ${inter.variable} ${jetbrains.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
