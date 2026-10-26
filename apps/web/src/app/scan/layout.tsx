import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./scan.css";

export const metadata: Metadata = {
  title: "Scanner",
  manifest: "/scan/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Scanner", statusBarStyle: "black-translucent" },
  icons: { icon: "/scan/icon-192.png", apple: "/scan/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#111827",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function ScanLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
