import type { ReactNode } from "react";
import "../dashboard.css";

export default function DashLayout({ children }: { children: ReactNode }) {
  return <div className="dash">{children}</div>;
}
