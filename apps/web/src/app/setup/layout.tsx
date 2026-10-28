import type { ReactNode } from "react";
import "../dashboard.css";

export const metadata = { title: "Set up this hub · Events QR" };

export default function SetupLayout({ children }: { children: ReactNode }) {
  return <div className="dash">{children}</div>;
}
