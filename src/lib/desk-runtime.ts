import { parseDeskEnv, type DeskEnv } from "./desk";
import { getPaperEngine } from "./engine";
import { getLiveEngine } from "./live-engine";
import type { PaperEngine } from "./engine";

export function getDeskEngine(env: DeskEnv | string | null | undefined = "paper"): PaperEngine {
  const desk = parseDeskEnv(typeof env === "string" ? env : "paper");
  return desk === "live" ? getLiveEngine() : getPaperEngine();
}

export function deskFromRequest(request: Request, bodyEnv?: string | null) {
  const url = new URL(request.url);
  return parseDeskEnv(bodyEnv ?? url.searchParams.get("env"));
}
