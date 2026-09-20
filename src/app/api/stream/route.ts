import { deskFromRequest, getDeskEngine } from "@/lib/desk-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function maybeAutostart(env: "paper" | "live", engine: ReturnType<typeof getDeskEngine>) {
  if (engine.running || engine.starting || engine.stoppedByUser) return;
  if (env === "paper" && process.env.PAPER_AUTOSTART !== "0") {
    void engine.start().catch((error) => console.error("paper engine failed to start", error));
    return;
  }
  if (env === "live" && process.env.LIVE_AUTOSTART === "1") {
    void engine.start().catch((error) => console.error("live engine failed to start", error));
  }
}

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  const env = deskFromRequest(request);
  const engine = getDeskEngine(env);
  maybeAutostart(env, engine);

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(engine.snapshot())}\n\n`));
      };
      send();
      const timer = setInterval(send, 1000);
      const stop = () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", stop);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
