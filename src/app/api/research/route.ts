import { getPaperEngine } from "@/lib/engine";
import { getExperiment, listExperiments } from "@/lib/storage/experiments";
import { parseMoney } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const experiments = await listExperiments(12);
  return Response.json({ experiments });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { experimentId?: string; startingUsdt?: number | string; name?: string };
  const report = body.experimentId ? await getExperiment(body.experimentId) : null;
  if (!report) return Response.json({ error: "Experiment not found" }, { status: 404 });
  if (!report.passed) {
    return Response.json({ error: "Walk-forward belum lolos. Tidak dipromosikan." }, { status: 400 });
  }
  try {
    const engine = getPaperEngine();
    if (!engine.running && !engine.starting) await engine.start();
    const agent = await engine.createAgent({
      name: body.name || `${report.strategy}_${report.id.slice(0, 8)}`,
      strategy: report.strategy,
      startingUsdt: parseMoney(body.startingUsdt ?? 1000),
      allocPct: 0.2,
    });
    return Response.json(agent);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
