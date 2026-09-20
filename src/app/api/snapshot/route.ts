import { deskFromRequest, getDeskEngine } from "@/lib/desk-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const env = deskFromRequest(request);
  const engine = getDeskEngine(env);
  if (
    env === "paper" &&
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
