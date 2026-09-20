import { deskFromRequest, getDeskEngine } from "@/lib/desk-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const env = deskFromRequest(request);
  const detail = await getDeskEngine(env).agentDetailFull(id);
  if (!detail) return Response.json({ error: "Agent not found" }, { status: 404 });
  return Response.json(detail);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as {
    startingUsdt?: number | string;
    allocPct?: number;
    env?: string;
  };
  try {
    const env = deskFromRequest(request, body.env);
    const agent = await getDeskEngine(env).updateAgent(id, body);
    return Response.json(agent);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const env = deskFromRequest(request);
    await getDeskEngine(env).removeAgent(id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
