import { getEngine } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const encoder = new TextEncoder();
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

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(engine.snapshot())}\n\n`),
        );
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
