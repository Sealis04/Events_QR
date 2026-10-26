import type { ReactNode } from "react";
import { InstanceBanner } from "./_components/InstanceBanner";

export const metadata = { title: "Events QR" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <InstanceBanner />
        {children}
      </body>
    </html>
  );
}
