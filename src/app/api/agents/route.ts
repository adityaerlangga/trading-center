import { getEngine } from "@/lib/engine";
import type { CreateAgentInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const engine = getEngine();
  return Response.json({
    agents: engine.snapshot().agents,
    strategies: engine.strategies(),
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as CreateAgentInput;
  try {
    const engine = getEngine();
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
