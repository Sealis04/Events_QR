import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isHubMode } from "../../server/mode";
import "../dashboard.css";

export const dynamic = "force-dynamic";

/**
 * On a venue hub that is not linked yet every dashboard page goes to `/setup` (the middleware
 * cannot read SQLite, so the check lives here).
 */
export default async function DashLayout({ children }: { children: ReactNode }) {
  if (isHubMode()) {
    const { getHubContext } = await import("../../hub/context");
    const { isLinked } = await import("../../hub/setup");
    if (!isLinked(await getHubContext())) redirect("/setup");
  }
  return <div className="dash">{children}</div>;
}
