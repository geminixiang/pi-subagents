import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createActivityTracker, MAX_ACTIVITY_ENTRIES } from "../src/agent-activity.js";
import type { AgentManager } from "../src/agent-manager.js";
import { resumeAgent } from "../src/agent-runner.js";
import type { AgentRecord } from "../src/types.js";
import { AgentWidget, SPINNER, type UICtx } from "../src/ui/agent-widget.js";

describe("activity history", () => {
  it("correlates concurrent same-name calls and updates status in place", () => {
    const { state, callbacks: cb } = createActivityTracker();
    cb.onTextStart(); cb.onTextDelta("Inspecting", "Inspecting");
    cb.onTextDelta(" files", "Inspecting files");
    cb.onToolActivity({ type: "start", toolCallId: "a", toolName: "read", args: { path: "src/a.ts", secret: "not retained" } });
    cb.onToolActivity({ type: "start", toolCallId: "b", toolName: "read", args: { path: "src/b.ts" } });
    cb.onToolActivity({ type: "end", toolCallId: "b", toolName: "read", isError: true });
    expect([...state.activeTools.keys()]).toEqual(["a"]);
    cb.onToolActivity({ type: "end", toolCallId: "a", toolName: "read", isError: false });
    cb.onToolActivity({ type: "end", toolCallId: "a", toolName: "read", isError: false });
    cb.onTextStart(); cb.onTextDelta("Next", "Next");
    expect(state.history).toEqual([
      { type: "text", text: "Inspecting files" },
      { type: "tool", toolCallId: "a", text: "Read src/a.ts", status: "success" },
      { type: "tool", toolCallId: "b", text: "Read src/b.ts", status: "error" },
      { type: "text", text: "Next" },
    ]);
    expect(state.toolUses).toBe(2);
    expect(state.activeTools.size).toBe(0);
    expect(JSON.stringify(state.history)).not.toContain("not retained");
  });

  it("bounds history and summaries and handles ends without starts", () => {
    const { state, callbacks: cb } = createActivityTracker();
    for (let i = 0; i < 40; i++) {
      cb.onTextStart(); cb.onTextDelta("x", `${i} ${"x".repeat(1000)}`);
    }
    expect(state.history).toHaveLength(MAX_ACTIVITY_ENTRIES);
    expect(state.omittedActivities).toBe(20);
    expect(state.history.every(entry => entry.text.length <= 240)).toBe(true);
    expect(state.responseText.length).toBeLessThanOrEqual(240);
    cb.onToolActivity({ type: "end", toolCallId: "blocked", toolName: "custom", isError: true });
    expect(state.history.at(-1)).toEqual({ type: "tool", toolCallId: "blocked", text: "custom", status: "error" });
  });
});

function mount(count = 1, showModel?: boolean, width = 160) {
  const trackers = Array.from({ length: count }, () => createActivityTracker());
  const records = trackers.map(({ state }, i) => {
    state.session = {
      model: { provider: "actual", id: "configured-model" }, thinkingLevel: "high",
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 68 } }),
    };
    return {
      id: String(i), type: "general-purpose", description: `agent ${i}`, status: "running", startedAt: Date.now(),
      toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0,
      invocation: { modelId: "requested/wrong", thinking: "max" },
    } as AgentRecord;
  });
  const widget = new AgentWidget({ listAgents: () => records } as AgentManager,
    new Map(trackers.map((tracker, i) => [String(i), tracker.state])), () => "all", () => false,
    showModel === undefined ? undefined : () => showModel);
  let factory: Exclude<Parameters<UICtx["setWidget"]>[1], undefined> | undefined;
  widget.setUICtx({ setStatus: () => {}, setWidget: (_key, value) => { factory = value; } });
  widget.update();
  const component = factory!({ terminal: { columns: width }, requestRender: () => {} }, { fg: (_color, text) => text, bold: text => text });
  return { trackers, render: () => component.render(), widget };
}

describe("activity widget", () => {
  it("shows five chronological entries, direct text, status prefixes, and canonical model by default", () => {
    const { trackers, render, widget } = mount();
    const cb = trackers[0].callbacks;
    for (const text of ["old", "Inspecting"]) { cb.onTextStart(); cb.onTextDelta(text, text); }
    cb.onToolActivity({ type: "start", toolCallId: "r", toolName: "read", args: { path: "src/file.ts" } });
    cb.onToolActivity({ type: "end", toolCallId: "r", toolName: "read", isError: false });
    cb.onToolActivity({ type: "start", toolCallId: "g", toolName: "grep", args: { pattern: "maxToolUses" } });
    cb.onToolActivity({ type: "end", toolCallId: "g", toolName: "grep", isError: true });
    cb.onTextStart(); cb.onTextDelta("Testing now", "Testing now");
    cb.onToolActivity({ type: "start", toolCallId: "b", toolName: "bash", args: { command: "npx vitest run test/file.test.ts" } });
    const lines = render();
    expect(lines[1]).toContain("agent 0");
    expect(lines[2].trim()).toBe("actual/configured-model:high");
    expect(lines[3]).toContain("context 68%");
    expect(lines.slice(-5).map(line => line.trim())).toEqual([
      "Inspecting", "✓ Read src/file.ts", "✗ Grep maxToolUses", "Testing now", `${SPINNER[1]} Bash npx vitest run test/file.test.ts`,
    ]);
    expect(lines.join("\n")).toContain("1 earlier activities omitted");
    expect(lines.join("\n")).not.toMatch(/latest.message|thinking…|requested\/wrong/);
    widget.dispose();
  });

  it("honors explicit model off and omits unknown thinking rather than guessing", () => {
    const off = mount(1, false);
    expect(off.render().join("\n")).not.toContain("actual/");
    off.widget.dispose();
    const unknown = mount();
    delete unknown.trackers[0].state.session!.thinkingLevel;
    expect(unknown.render().join("\n")).toContain("actual/configured-model");
    expect(unknown.render().join("\n")).not.toContain("configured-model:");
    unknown.widget.dispose();
  });

  it("caps populated fleets and terminal widths, preserving omission indicators", () => {
    for (let count = 1; count <= 8; count++) {
      const { trackers, render, widget } = mount(count, undefined, 80);
      for (const { callbacks: cb } of trackers) {
        for (let i = 0; i < 8; i++) { cb.onTextStart(); cb.onTextDelta("x", `${i} ${"界".repeat(100)}`); }
      }
      const lines = render();
      expect(lines.length).toBeLessThanOrEqual(12);
      expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
      expect(lines.join("\n")).toContain("activities omitted");
      if (count > 2) expect(lines.join("\n")).toContain("more (");
      widget.dispose();
    }
  });
});

describe("resume public activity subscription", () => {
  it.each([false, true])("forwards IDs, args, errors, text boundaries and turns; cleans up (reject=%s)", async reject => {
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const tracker = createActivityTracker();
    const onTurnEnd = vi.fn(tracker.callbacks.onTurnEnd);
    const emit = (event: unknown) => { for (const listener of listeners) listener(event as AgentSessionEvent); };
    const session = {
      messages: [],
      subscribe: (listener: (event: AgentSessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      prompt: async () => {
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "First" } });
        emit({ type: "tool_execution_start", toolCallId: "id", toolName: "read", args: { path: "src/file.ts" } });
        emit({ type: "tool_execution_end", toolCallId: "id", toolName: "read", isError: true, result: "private result" });
        emit({ type: "turn_end" });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Second" } });
        emit({ type: "turn_end" });
        if (reject) throw new Error("failed");
      },
    } as unknown as AgentSession;
    const result = resumeAgent(session, "continue", { ...tracker.callbacks, onTurnEnd });
    if (reject) await expect(result).rejects.toThrow("failed"); else await result;
    expect(tracker.state.history).toEqual([
      { type: "text", text: "First" },
      { type: "tool", toolCallId: "id", text: "Read src/file.ts", status: "error" },
      { type: "text", text: "Second" },
    ]);
    expect(onTurnEnd.mock.calls).toEqual([[1], [2]]);
    expect(listeners.size).toBe(0);
  });
});
