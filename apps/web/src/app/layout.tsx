import type { ReactNode } from "react";

export const metadata = { title: "Events QR" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
