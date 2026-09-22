import { fileURLToPath } from "node:url";

// Resolve from this module, not the project cwd: docs ship beside both src/ and
// dist/. The full DSL and recipes are read on demand, never injected at startup.
export const workflowAuthoringPath = fileURLToPath(new URL("../../docs/workflow-authoring.md", import.meta.url));

export const fullWorkflowToolDescription = `Run a deterministic JavaScript workflow orchestrating subagents. Returns a task ID immediately; completion notifies later. Do not poll or sleep waiting. Never fabricate or predict pending results; if asked, say it is still running. Inspect/stop via /agents → Workflows.

ONLY use with explicit user opt-in: the user requests a workflow or multi-agent orchestration, invokes a skill/slash command instructing SubagentWorkflow, or asks for a named/saved workflow. Suitability or implied parallelism is not consent. Otherwise use individual Agent calls or explain scope/cost and ask first; workflows can spend many tokens.

Before authoring or editing ANY workflow, read the complete local DSL and recipes at: ${workflowAuthoringPath}

Essential contracts:
- Plain JS, not TypeScript. Begin with pure-literal export const meta = { name, description }; optional phases/whenToUse. Async body permits await and return; await all agent calls. Return JSON-shaped data; only the return value reaches the caller.
- Globals: agent, pipeline, parallel, workflow, phase, log, args, budget. Real I/O belongs in agents: no filesystem/network/modules in scripts; Date.now(), argless new Date(), Math.random(), eval and Function throw.
- agent(prompt, opts?) returns text, schema-validated object, or null on failure/skip. Filter nulls. Options/combination rules are in the reference; types are in Agent's live roster. Prefer pipeline for per-item stages; parallel is a barrier only for cross-item dependencies. Use per-agent phase inside concurrent stages.
- Omit model/effort unless needed. Worktree copies cost time/disk: only for parallel writes that would collide, never to inspect uncommitted/staged main-checkout changes. Removed on settle; changes preserved on a branch. Agent/project isolation settings still apply.
- Pass new source inline as script (no file-writing step needed); edit the returned file and rerun via scriptPath, or save under a workflow name. Source precedence: scriptPath > script > name; resumeFromRunId alone reuses that run's script. Pass args as actual JSON, not JSON-encoded strings.
- Resume replays only the unchanged leading agent() calls of a finished run in this session; first changed/failed call onward runs live. Runs using agent({resume}) cannot replay. Inspect the sibling <run id>.workflow.jsonl before diagnosing unexpected results.
- Caps: 1000 agents/run, 4096 items per pipeline/parallel, max(1, min(16, CPUs - 2)) concurrent agents. Nested workflow() is one level, 256 calls/run. budget.total is null (no token target); spent() counts output tokens, remaining() is Infinity.`;
