import { notFound, redirect } from "next/navigation";
import { isHubMode } from "../../server/mode";
import { SetupCard } from "./SetupCard";

export const dynamic = "force-dynamic";

/** Hub only. The VM has no such page; a linked hub no longer shows it. */
export default async function SetupPage() {
  if (!isHubMode()) notFound();
  const { getHubContext } = await import("../../hub/context");
  const { hubStatus } = await import("../../hub/setup");
  const status = hubStatus(await getHubContext());
  if (status.linked) redirect("/login");
  return <SetupCard serverUrl={status.server_url} />;
}
