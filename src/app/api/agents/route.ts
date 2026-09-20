import { deskFromRequest, getDeskEngine } from "@/lib/desk-runtime";
import type { CreateAgentInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const env = deskFromRequest(request);
  const engine = getDeskEngine(env);
  return Response.json({
    env,
    agents: engine.snapshot().agents,
    strategies: engine.strategies(),
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as CreateAgentInput & { env?: string };
  try {
    const env = deskFromRequest(request, body.env);
    const engine = getDeskEngine(env);
    if (env === "live") {
      return Response.json({ error: "Live desk hanya 1 agent tetap." }, { status: 400 });
    }
    if (!engine.running && !engine.starting) {
      await engine.start();
    }
    const agent = await engine.createAgent(body);
    return Response.json(agent);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
