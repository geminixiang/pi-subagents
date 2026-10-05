import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, setRememberAgents } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

describe("codemode in real headless subagent sessions", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  const sessions: AgentSession[] = [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagent-codemode-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "home"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "codemode-test" }] });
    setRememberAgents(false);
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    faux.unregister();
    registerAgents(new Map());
    setRememberAgents(true);
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function headless(type: string, frontmatter?: string, isolated = false): Promise<AgentSession> {
    if (frontmatter !== undefined) {
      writeFileSync(join(cwd, ".pi", "agents", `${type}.md`), `---\ndescription: Test agent\n${frontmatter}\n---\nTest.`);
    }
    registerAgents(loadCustomAgents(cwd));
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx = {
      cwd, model, getSystemPrompt: () => "Parent",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
    } as unknown as ExtensionContext;
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
    const stop = new Error("headless: no model turn");
    let captured: AgentSession | undefined;
    await expect(runAgent(ctx, type, "unused", {
      pi, model, isolated,
      onSessionCreated: (session) => {
        captured = session;
        sessions.push(session);
        throw stop;
      },
    })).rejects.toBe(stop);
    if (!captured) throw new Error("Session was not created");
    return captured;
  }

  async function script(session: AgentSession, code: string): Promise<string> {
    faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code })]), "done"]);
    await session.prompt("Run the script.");
    const result = session.messages.findLast((m) => m.role === "toolResult" && m.toolName === "codemode");
    if (!result || result.role !== "toolResult") throw new Error("No codemode result");
    return result.content.map((block) => block.type === "text" ? block.text : "").join("\n");
  }

  it.each(["general-purpose", "Explore", "Plan"])("activates codemode alongside %s's tools", async (type) => {
    const session = await headless(type);
    expect(session.getActiveToolNames()).toContain("codemode");
    expect(session.getActiveToolNames()).toContain("read");
    expect(session.getActiveToolNames()).not.toContain("Agent");
  });

  it.each(["", "extensions: none"])("adds codemode to restricted markdown tools (%s)", async (extensions) => {
    const session = await headless("custom", `tools: read, grep, find, ls, bash\n${extensions}`);
    expect(session.getActiveToolNames().sort()).toEqual(["read", "grep", "find", "ls", "bash", "codemode"].sort());
    writeFileSync(join(cwd, "marker.txt"), "CODEMODE_READ_OK");
    const result = await script(session, 'return await tools.read({path: "marker.txt"});');
    expect(result).toContain("Script completed");
    expect(result).toContain("CODEMODE_READ_OK");
    const catalog = await script(session, "return ALL_TOOLS.map(t => t.name).sort();");
    expect(catalog).toContain('["bash","find","grep","ls","read"]');
    expect(await script(session, "return await tools.Agent({});")).toContain("Script failed");
    expect(await script(session, "return await tools.codemode({code: 'return 1'});")).toContain("Script failed");
  });

  it("keeps codemode for isolated agents and tools: none", async () => {
    const session = await headless("custom", "tools: none", true);
    expect(session.getActiveToolNames()).toEqual(["codemode"]);
    expect(await script(session, "return ALL_TOOLS;")).toContain("[]");
  });

  it.each(["extensions: none", "extensions: true"])("honors disallowed_tools: codemode (%s)", async (extensions) => {
    const session = await headless("custom", `tools: read\n${extensions}\ndisallowed_tools: codemode`);
    expect(session.getActiveToolNames()).toEqual(["read"]);
    expect(session.getToolDefinition("codemode")).toBeUndefined();
  });

  it.each(["deferred", "codemode"])("does not expose parent orchestration or unselected %s extension tools", async (exposure) => {
    const extension = join(cwd, "scope.mjs");
    writeFileSync(extension, `export default function(pi) {
      for (const name of ["Agent", "SubagentWorkflow", "selected", "unselected"]) {
        pi.registerTool({ name, label: name, description: name, exposure: "${exposure}",
          parameters: {type: "object", properties: {}},
          execute: async () => ({content: [{type: "text", text: name + " executed"}]}) });
      }
    }`);
    const session = await headless("custom", `tools: read, ext:scope.mjs/selected\nextensions: ${extension}`);
    expect(session.getActiveToolNames()).toContain("codemode");
    expect(session.getToolDefinition("Agent")).toBeUndefined();
    expect(session.getToolDefinition("SubagentWorkflow")).toBeUndefined();
    const catalog = await script(session, "return ALL_TOOLS.map(t => t.name).sort();");
    expect(catalog).toContain('["read","selected"]');
    expect(await script(session, "return await tools.selected({});")).toContain("selected executed");
    expect(await script(session, "return await tools.unselected({});")).toContain("Script failed");
    expect(await script(session, "return await tools.Agent({});")).toContain("Script failed");
  });
});
