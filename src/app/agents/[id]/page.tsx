import { AgentDetail } from "@/components/agent-detail";
import { parseDeskEnv } from "@/lib/desk";

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ env?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const env = parseDeskEnv(query.env) === "live" || id.startsWith("live_") ? "live" : "paper";
  return <AgentDetail id={id} env={env} />;
}
