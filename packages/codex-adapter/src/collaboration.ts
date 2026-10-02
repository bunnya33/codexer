import type { CollaborationMode } from "../../codex-generated/src/CollaborationMode.js";
import type { ReasoningEffort } from "../../codex-generated/src/ReasoningEffort.js";
import { AdapterError } from "./desktop.js";

export function collaborationOverride(mode: "default" | "plan", model: string, effort: string | null): CollaborationMode {
  if (effort !== null && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw new AdapterError("unsupported-effort");
  return { mode, settings: { model, reasoning_effort: effort as ReasoningEffort | null, developer_instructions: null } };
}
