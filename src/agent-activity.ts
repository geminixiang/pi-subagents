import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolActivity } from "./agent-runner.js";
import type { AgentActivity } from "./ui/agent-widget.js";
import type { LifetimeUsage } from "./usage.js";

/** Keep only display summaries, never tool arguments/results or reasoning. */
export const MAX_ACTIVITY_ENTRIES = 20;
const MAX_SUMMARY_LENGTH = 240;

export type ActivityEntry =
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string; text: string; status: "active" | "success" | "error" };

function summarize(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY_LENGTH ? line.slice(0, MAX_SUMMARY_LENGTH - 1) + "…" : line;
}

function toolSummary(toolName: string, args: unknown): string {
  const name = toolName.toLowerCase();
  const keys: Record<string, string[]> = {
    read: ["path", "file_path"], edit: ["path", "file_path"], write: ["path", "file_path"],
    grep: ["pattern"], find: ["pattern"], bash: ["command"], ls: ["path"],
  };
  const fields = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const target = keys[name]?.map(key => fields[key]).find(value => typeof value === "string");
  const label = keys[name] ? name[0].toUpperCase() + name.slice(1) : toolName;
  return summarize(label + (typeof target === "string" ? ` ${target}` : ""));
}

export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(), history: [], omittedActivities: 0,
    toolUses: 0, turnCount: 1, maxTurns, responseText: "",
  };
  let currentText: Extract<ActivityEntry, { type: "text" }> | undefined;
  const append = (entry: ActivityEntry) => {
    state.history.push(entry);
    if (state.history.length > MAX_ACTIVITY_ENTRIES) {
      state.history.shift();
      state.omittedActivities++;
    }
  };

  const callbacks = {
    onToolActivity: (activity: ToolActivity) => {
      let entry = state.history.find((item): item is Extract<ActivityEntry, { type: "tool" }> =>
        item.type === "tool" && item.toolCallId === activity.toolCallId);
      if (activity.type === "start") {
        state.activeTools.set(activity.toolCallId, activity.toolName);
        if (!entry) {
          entry = { type: "tool", toolCallId: activity.toolCallId, text: toolSummary(activity.toolName, activity.args), status: "active" };
          append(entry);
        }
      } else {
        const wasActive = state.activeTools.delete(activity.toolCallId);
        if (!entry && wasActive) {
          // Do not resurrect an evicted start at the end of chronological history.
          state.toolUses++;
          onStreamUpdate?.();
          return;
        }
        if (!entry) {
          // A blocked call may end without a start.
          entry = { type: "tool", toolCallId: activity.toolCallId, text: toolSummary(activity.toolName, undefined), status: "active" };
          append(entry);
        }
        if (entry.status === "active") state.toolUses++;
        entry.status = activity.isError ? "error" : "success";
      }
      currentText = undefined;
      onStreamUpdate?.();
    },
    onTextStart: () => {
      currentText = undefined;
      state.responseText = "";
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = summarize(fullText);
      if (state.responseText) {
        if (!currentText) {
          currentText = { type: "text", text: state.responseText };
          append(currentText);
        } else {
          currentText.text = state.responseText;
        }
      }
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: AgentSession) => { state.session = session; },
    // The record owns lifetime spend; the tracker only requests a repaint.
    onAssistantUsage: (_usage: LifetimeUsage) => { onStreamUpdate?.(); },
  };
  return { state, callbacks };
}
