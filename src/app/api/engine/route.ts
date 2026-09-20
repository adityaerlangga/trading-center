import { getEngine } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  const engine = getEngine();

  try {
    if (body.action === "start") await engine.start();
    else if (body.action === "stop") await engine.stop();
    else if (body.action === "reset") await engine.reset();
    else return Response.json({ error: "Unknown action" }, { status: 400 });
    return Response.json(engine.snapshot());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
