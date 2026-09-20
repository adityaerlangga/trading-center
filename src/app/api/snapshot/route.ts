import { getEngine } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const engine = getEngine();
  if (
    !engine.running &&
    !engine.starting &&
    !engine.stoppedByUser &&
    process.env.PAPER_AUTOSTART !== "0"
  ) {
    void engine.start().catch((error) => {
      console.error("paper engine failed to start", error);
    });
  }
  return Response.json(engine.snapshot());
}
