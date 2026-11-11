# Gateways, observability, visualization, guardrails and loop control planes for LLM coding agents

Research survey for **qharness**, an outer/platform harness around Claude Code and OpenCode connected over ACP (Agent Client Protocol, Zed). Components under consideration: Looping, Gateway, Logging, Trace, Visualization, Guardrails.

Date of survey: 2026-11-09. Only links that were opened or returned by search during this survey are cited. Vendor-authored comparisons are flagged as such. Where a claim came only from secondary sources, it is marked "(secondary)".

---

## 0. Two meanings of "gateway" (framing)

| | LLM / API gateway | Agent-control gateway (what qharness is) |
|---|---|---|
| Sits between | app code ↔ model providers | human/UI ↔ coding agent process (ACP) |
| Unit of control | one HTTP request to a model | one tool call / one turn / one session |
| Typical features | key management, budgets, routing, fallbacks, caching, provider-level guardrails, request logs | permission decisions, tool-call policy, loop control (stop/continue/retry), session replay, worktree/sandbox management |
| Examples | LiteLLM, Portkey, Kong AI Gateway, Cloudflare AI Gateway, Helicone, OpenRouter, Bifrost | Claude Code hooks/mods, OpenCode plugins, Zed Agent Panel, Vibe Kanban, Claude Squad, Invariant Gateway (closest crossover) |

Key implication: an LLM gateway only sees `messages[]` and tool *definitions*; it never sees the tool *execution* (file writes, shell). An agent-control gateway sees execution but, when the agent runs on a subscription (Claude Code via `/login`), usually cannot sit in front of the model call at all. qharness should expose both seams: ACP for execution-level control, and an optional `ANTHROPIC_BASE_URL`-style model proxy for API-key users.

---

## 1. LLM / agent gateways

### LiteLLM (BerriAI) — OSS (core) + Enterprise
- Links: https://www.litellm.ai/ , guardrails docs https://docs.litellm.ai/docs/proxy/guardrails/quick_start
- Python proxy over 100+ providers. Virtual keys per user/team with model allow-lists, rate limits and hard budgets (returns 429 when exceeded); spend tracking needs PostgreSQL. Guardrails configured in `config.yaml` with modes `pre_call`, `post_call`, `during_call`, `logging_only`; providers include Presidio (PII), Lakera, Aporia, Bedrock Guardrails, Guardrails AI, Azure moderation, hide-secrets, plus a generic custom API; per-key/per-team attachment is Enterprise.
- Relevance: the pragmatic model-side proxy for qharness when users run on API keys. Reusable as-is (don't rebuild budgets/keys).

### Portkey AI Gateway — OSS gateway (MIT; some sources say Apache 2.0 after 2026 merge) + SaaS
- Links: https://portkey.ai/features/guardrails , comparisons (vendor/secondary) https://www.tooljunction.io/blog/?p=3949
- Node gateway with retries, fallbacks, load balancing, conditional routing and 50+ guardrail checks; Gateway 2.0 adds MCP support and team-level access control for MCP tools (secondary). Company was acquired by Palo Alto Networks and now presents as "PRISMA AIRS AI Gateway" (https://portkey.ai/for/network-level-guardrails); one reviewer notes slowed OSS activity in 2026 (secondary).
- Relevance: reference design for a *guardrail plugin pipeline* on the model path; maintenance risk means don't take a hard dependency.

### Kong AI Gateway — OSS core (Kong Gateway) + Enterprise AI plugins
- Links: https://developer.konghq.com/plugins/ai-proxy/ , https://docs.konghq.com/plugins/ai-prompt-guard , https://docs.konghq.com/plugins/ai-semantic-prompt-guard
- `ai-proxy` normalizes `llm/v1/chat` requests to many providers; `ai-prompt-guard` applies regex allow/deny lists, `ai-semantic-prompt-guard` blocks by embedding similarity; AI Semantic Cache and AI Rate Limiting Advanced (Enterprise). Best when Kong is already the API gateway.
- Relevance: low direct reuse; good example of "prompt guard as a plugin chain" and of the regex vs semantic trade-off.

### Cloudflare AI Gateway — SaaS (available on all plans)
- Link: https://developers.cloudflare.com/ai-gateway/
- Edge proxy with logging, analytics (requests, tokens, cost), caching, rate limiting, retries/model fallback, model aliases and dynamic routes.
- Relevance: zero-ops option for teams already on Cloudflare; no execution-level control. Shows the minimal "gateway dashboard" feature set users expect.

### Helicone — OSS (Apache 2.0) + cloud
- Link: https://github.com/Helicone/helicone
- Rust AI Gateway (100+ models via OpenAI format, routing, fallbacks) plus observability (traces, sessions, cost/latency, prompt playground, PostHog export). Self-host via docker-compose (Web, Worker, Jawn, Supabase, ClickHouse, MinIO); async logging via OpenLLMetry.
- Relevance: example of gateway + observability in one product; its "sessions" model is close to a coding-agent session view.

### OpenRouter — SaaS
- Link (comparison, secondary): https://keywordsai.co/market-map/compare/helicone-vs-openrouter
- Hosted router: one key, 300–400+ models, provider failover, usage-based pricing.
- Relevance: a *provider*, not a control plane; relevant only as a backend qharness may point OpenCode at.

### Bifrost (Maxim AI) — OSS (Apache 2.0) + Enterprise
- Link: https://github.com/maximhq/bifrost
- Go gateway: OpenAI-compatible API over 23+ providers, failover, key load balancing, virtual keys with hierarchical budgets (key → team → customer), rate limits, Prometheus metrics, distributed tracing, and an **MCP gateway** (models call tools through Bifrost; enterprise tier). Self-reported 11 µs overhead at 5k RPS.
- Relevance: the only gateway in this list that also brokers *tool calls* (MCP), so it is the closest existing thing to a model+tool gateway. Worth studying its MCP governance model.

### Invariant Gateway (Invariant Labs → Snyk) — OSS (Apache 2.0)
- Link: https://github.com/invariantlabs-ai/invariant ; MCP-scan on PyPI https://pypi.org/project/mcp-scan/
- Proxy between app and LLM provider **and** between agent and MCP servers; evaluates rule-based policies before/after each call. See §4.
- Relevance: the existing project whose architecture (proxy + trace-level policy language) most resembles qharness's Guardrails component.

---

## 2. Tracing and observability

### How the agents emit telemetry (primary sources)

**Claude Code native OpenTelemetry** — https://code.claude.com/docs/en/monitoring-usage.md
- Opt-in: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp|prometheus|console|none`, `OTEL_LOGS_EXPORTER=otlp|console|none`, `OTEL_EXPORTER_OTLP_PROTOCOL` (grpc / http/json / http/protobuf, no default), `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`; per-signal overrides exist.
- Metrics: `claude_code.session.count`, `lines_of_code.count`, `pull_request.count`, `commit.count`, `cost.usage` (USD, per API request), `token.usage` (input/output/cacheRead/cacheCreation), `code_edit_tool.decision`, `active_time.total`.
- Events (OTel logs): `claude_code.user_prompt`, `assistant_response`, `tool_result` (tool_name, tool_use_id, success, duration_ms, decision_source, sizes, error_type), `tool_decision` (decision accept/reject, source config/hook/user_*, permission_mode), `api_request` (model, cost_usd, tokens, request_id), `api_error`, `api_refusal`, `api_request_body`/`api_response_body` (only with `OTEL_LOG_RAW_API_BODIES`), `safety_event`. Correlation keys: `prompt.id`, `event.sequence`, `request_id`, `tool_use_id`.
- Traces (beta): add `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and `OTEL_TRACES_EXPORTER=otlp`. Span tree: `claude_code.interaction` → `claude_code.llm_request`, `claude_code.hook`, `claude_code.tool` → `tool.blocked_on_user`, `tool.execution`, subagent spans nested under the Agent tool. `TRACEPARENT` is propagated to Bash subprocesses and as a `traceparent` header to the API / HTTP MCP servers (gated by `CLAUDE_CODE_PROPAGATE_TRACEPARENT=1` when `ANTHROPIC_BASE_URL` is custom).
- Privacy flags all default off: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES`; `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` (60 KB default).
- Resource attrs: `session.id`, `user.id`, `organization.id`, `app.version`, `terminal.type`, optional `vcs.*` repo attrs; custom via `OTEL_RESOURCE_ATTRIBUTES`. Repo-level `.claude/settings.json` **cannot** set OTel vars (only disable); managed settings can lock endpoints. Subprocesses (hooks, MCP servers) do not inherit `OTEL_*`.

**Claude Code hooks** — https://code.claude.com/docs/en/hooks.md
- Events: `SessionStart/End`, `Setup`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart/Stop`, `TaskCreated/Completed`, `PreCompact/PostCompact`, `PreModelSwitch/PostModelSwitch`, `Notification`, `Elicitation*`, `Worktree*`, `FileChanged`, `ConfigChange`, etc.
- Input JSON: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `prompt_id`, `agent_id`, `agent_type`, `tool_name`, `tool_input`, `tool_use_id`. Output: `hookSpecificOutput.permissionDecision` (`allow|deny|ask|defer`), `updatedInput`, `additionalContext`, `updatedToolOutput`, top-level `continue`/`stopReason`, `decision: "block"`. Exit 2 = block. Async hooks (`async`, `asyncRewake`), `onFailure: "block"` (v2.1.295+) for fail-closed, HTTP hooks (POST body), per-hook `timeout`.

**Claude Code transcript JSONL** (unofficial, community-documented) — https://claude-dev.tools/docs/jsonl-format , https://gist.github.com/samkeen/dc6a9771a78d1ecee7eb9ec1307f1b52
- `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, subagents as `agent-<uuid>.jsonl`. Records: `type`, `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`; assistant `tool_use` blocks (id, name, input) and user `tool_result` blocks (`tool_use_id`, `is_error`). Format is undocumented and drifts between versions.

**Claude Code mods** (in-process JS/TS handlers) — https://code.claude.com/docs/en/plugins/mods/overview.md
- Handlers on `tool.call`, prompts, turns, `ui.render`; can draw panes/bands, hold or rewrite tool calls, call models. Not sandboxed; run inside CLI, Desktop Code tab, VS Code; hooks run (no drawing) under `claude -p`/Agent SDK/cloud. Sample mods: `token-weather` (context forecast), `blast-radius` (holds `rm -rf`/force-push and shows impact), `replay-theater` (`/replay` of last turn's edits) at https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods. Built-in mod sources (incl. `telemetry`, `sec-default` policy mod) at https://github.com/anthropics/claude-code/tree/main/mods.

**OpenCode logging/plugins** — https://opencode.ai/v2/docs/troubleshooting , https://opencode.ai/docs/plugins/
- Log file `~/.local/share/opencode/log/opencode.log` (line `role=server` covers plugins, sessions, providers, permissions, tools). Session storage has moved from JSON under `storage/` to SQLite `~/.local/share/opencode/opencode.db` (WAL; `OPENCODE_DB` override) — check which exists for the installed version (secondary: https://www.skills.sh/dzianisv/opencode-plugins/opencode-session-db).
- Plugin hooks (third-party references, verify against `@opencode-ai/plugin` types): `event`, `tool.execute.before/after` (rewrite args or throw to block), `permission.ask` (set `status` allow/deny/ask), `chat.message`, etc. Community loggers: `@frankhommers/opencode-plugin-logger` (per-session JSONL), `opencode-session-log`, `opencode-agent-trace-plugin` (Postgres). Langfuse has an OpenCode integration page (https://langfuse.com/integrations/developer-tools/opencode.md).

**ACP (Agent Client Protocol, Zed)** — https://agentclientprotocol.com/protocol/overview , https://agentclientprotocol.com/protocol/tool-calls
- JSON-RPC 2.0; agent typically a subprocess of the client. Methods: `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`; client-side `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `elicitation/create`; notification `session/update`.
- `session/update` carries message chunks (agent/user/thought), **`tool_call`** (`toolCallId`, `title`, `name`, `kind` ∈ read/edit/delete/move/search/execute/think/fetch/switch_mode/other, `status` ∈ pending/in_progress/completed/failed, `content` incl. `diff` and `terminal`, `locations`, `rawInput`, `rawOutput`), **`tool_call_update`**, plans, available commands, mode changes, notices, context compactions. Permission: options with `kind` ∈ `allow_once|allow_always|reject_once|reject_always`; outcome `selected|cancelled`. Extensible via `_meta` and `_`-prefixed methods.
- Relevance: this *is* qharness's event source. Every ACP `tool_call`/`tool_call_update` maps cleanly to one OTel `execute_tool` span; `session/request_permission` is the Guardrails interception point.

### Standards

**OpenTelemetry GenAI semantic conventions** — https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans (now redirects; conventions moved to https://github.com/open-telemetry/semantic-conventions-genai)
- Status: Development (not stable); moved to a separate repo (reported v1.42.0, June 2026, per https://www.dash0.com/knowledge/opentelemetry-genai-semantic-conventions-explained ). Agent spans: `invoke_agent {gen_ai.agent.name}` (CLIENT or INTERNAL), `create_agent`; tool spans `execute_tool {gen_ai.tool.name}` with `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`; inference spans `chat {model}`; shared attrs `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.usage.input_tokens/output_tokens`. Metrics such as `gen_ai.invoke_agent.duration`, `gen_ai.execute_tool.duration` (per Dash0/Honeycomb write-ups: https://docs.honeycomb.io/send-data/agents ). The repo also covers MCP conventions.
- Relevance: adopt as the trace schema (see recommendations). Claude Code's own `claude_code.*` span names are proprietary; qharness should map them onto GenAI conventions.

**Datadog LLM Observability span kinds** — https://docs.datadoghq.com/llm_observability/span_kinds
- `llm`, `workflow` (static sequence), `agent` (dynamic, LLM-decided), `tool`, `task`, `embedding`, `retrieval`. Useful taxonomy even if not using Datadog.

### Platforms

| Platform | Org | Link | OSS? | Notes / relevance |
|---|---|---|---|---|
| **Langfuse** | Langfuse | https://langfuse.com/integrations/developer-tools/claude-code , https://github.com/langfuse/Claude-Observability-Plugin , https://langfuse.com/resources/engineering/coding-agent-tracing | OSS (self-host) + cloud | Claude Code integration via Stop hook + transcript parsing; plugin traces turns, generations, tool calls, thinking, subagents, images, token/cost; `CC_LANGFUSE_TRACEPARENT` nests a session under a parent trace. OTLP endpoint for native OTel. Guide explicitly says: hook-based tracing is telemetry, not enforcement; enforce at gateway. Strongest OSS default for qharness trace storage. |
| **LangSmith** | LangChain | https://docs.langchain.com/langsmith/observability-concepts , https://docs.langchain.com/langsmith/self-hosted | Proprietary (SDK MIT); self-host Enterprise-only | Runs ≈ spans, traces per turn, `thread_id` groups turns, "trajectories" flatten a thread to messages. Good vocabulary (thread/trace/run/trajectory). |
| **Arize Phoenix** | Arize | https://github.com/Arize-ai/phoenix , https://github.com/Arize-ai/openinference | ELv2 (source-available) | OTel-native via OpenInference auto-instrumentation; Claude Agent SDK, OpenAI Agents, LangGraph, CrewAI, MCP integrations; evals; Docker/Helm. Alternative OSS backend if Langfuse not chosen. |
| **OpenLLMetry** | Traceloop | https://github.com/traceloop/openllmetry | Apache 2.0 | OTel instrumentations for 17+ LLM providers, vector DBs, frameworks and MCP; exports to ~25 backends. Its LLM semconv fed the OTel GenAI spec. Use its Anthropic/OpenAI instrumentation inside qharness's own model proxy. |
| **AgentOps** | AgentOps-AI | https://github.com/AgentOps-AI/agentops | MIT SDK + cloud | Agent session replay, cost tracking, benchmarking; OTel-based. Reference for a "session replay" UX. |
| **Braintrust** | Braintrust | https://braintrust.dev/docs/guides/tracing , https://www.braintrust.dev/docs/frameworks/opentelemetry | Proprietary | Eval-first; accepts OTel (and OpenLLMetry) traces; has a Claude Code tracing plugin (secondary). Relevant if qharness wants eval/regression harness later. |
| **W&B Weave** | Weights & Biases / CoreWeave | https://docs.wandb.ai/weave/ (redirects to docs.coreweave.com/weave) | SDK OSS; platform SaaS | Hierarchical call trees, scorers on traces, cost/latency per agent (secondary: https://www.respan.ai/market-map/compare/agentops-vs-weights-and-biases ). |
| **Datadog LLM Observability** | Datadog | https://docs.datadoghq.com/llm_observability/ | SaaS | Agent monitoring, Insights, Safeguards (PII, prompt-injection evals), OTel GenAI support; billed per LLM span. Target for enterprises already on Datadog. |
| **Laminar (lmnr)** | Laminar | https://github.com/lmnr-ai/lmnr , https://laminar.sh/article/langfuse-alternatives-2026 (vendor) | Apache 2.0 | OTel-native, transcript view, dedups repeated conversation prefixes, "Signals" (prompt-defined failure detectors clustered over traces), cached-replay debugger, SQL over traces. Good ideas for long-running coding-agent traces. |
| **Helicone** | Helicone | https://github.com/Helicone/helicone | Apache 2.0 | Gateway + sessions/traces; see §1. |
| **OTel backends with Claude Code guides** | SigNoz, Axiom, Dash0, Better Stack, OpenObserve, Cribl | https://signoz.io/docs/claude-code-monitoring , https://axiom.co/docs/guides/opentelemetry-claude-code , https://www.dash0.com/guides/monitoring-claude-code-opentelemetry , https://betterstack.com/docs/logs/claude-code/ , https://openobserve.ai/docs/integration/ai/claude-code-tracing/ , https://docs.cribl.io/llm-observability/claude-code/ ; community stack https://github.com/colemurray/claude-code-otel | mixed | Any OTLP sink works with Claude Code's native export; OpenObserve documents the per-turn root span → LLM/tool child spans shape. |

---

## 3. Visualization of agent runs

| Tool | Org | Link | OSS? | What it shows / relevance |
|---|---|---|---|---|
| **Zed Agent Panel (ACP host)** | Zed | https://zed.dev/docs/ai/agent-panel , https://zed.dev/docs/ai/external-agents , https://zed.dev/docs/ai/tool-permissions | OSS (Zed) | Reference ACP client UI: streaming tool indicators, Review Changes multibuffer (accept/reject per hunk), terminal threads, permission cards (Allow/Deny), thread history, token usage, follow mode; `dev: open acp logs`. Zed notes external agents keep "classic" permission UI and that native and ACP permissions can both apply. qharness's Visualization should at least match this baseline and add what Zed lacks: cross-session/cross-agent views, cost, policy decisions. |
| **Claude Code mods / HUDs** | Anthropic; jarrodwatts | https://code.claude.com/docs/en/plugins/mods/overview.md ; https://github.com/jarrodwatts/claude-hud | mods: Anthropic; claude-hud MIT | In-terminal panes (context chart, blast-radius guard, replay of edits). claude-hud status line: context bar, rate limits, active tools, running agents, todo progress, reading stdin status JSON + transcript. Shows which per-session signals developers want at a glance. |
| **ccusage** | ryoppippi | https://github.com/ryoppippi/ccusage (via https://www.mintlify.com/ryoppippi/ccusage ) | OSS | Parses local Claude Code JSONL to report tokens/cost by day/month/session plus the live 5-hour billing window; statusline integration. Cost attribution logic to reuse or replicate. |
| **Claude Code transcript viewers** | community | https://www.memoryplugin.com/tools/claude-code-viewer , https://glama.ai/mcp/servers/@maxturazzini/claude-viewer/blob/2b09436acb16194072c41bbb82331897f6ac0ea4/DATASOURCES.md | OSS | Browser/CLI transcript viewers; claude-devtools-style token attribution, tool-call inspection, subagent trees, cross-session search (secondary). |
| **OpenHands Trajectory Visualizer** | OpenHands (All-Hands) | https://github.com/openhands/trajectory-visualizer , GUI https://www.openhands.dev/product/gui | MIT | Step timeline of actions (blue) vs observations (gray/red), keyboard stepping, load by upload / `fileUrl` / base64 `data`. Minimal, clear "trajectory replay" design; MLflow integration exists (https://www.mlflow.org/blog/mlflow-openhands/). |
| **Devin session board / API** | Cognition | https://docs.devin.ai/sdk/examples/session-board.md , https://fast.io/resources/devin-api-guide/ | SaaS | Session list, event streaming, follow-up messages, parent/child sessions, notification inbox, "Agent Command Center" (secondary). Model for a multi-session dashboard. |
| **Vibe Kanban** | BloopAI | https://github.com/BloopAI/vibe-kanban | Apache 2.0 (README says project is sunsetting) | Kanban → worktree per task → agent (Claude Code, Codex, Gemini, Copilot, Amp, Cursor, OpenCode, Droid, Qwen); diff review with inline comments back to the agent; built-in browser; PR creation; Rust backend. Closest existing "outer harness UI". |
| **Claude Squad** | smtg-ai | https://github.com/smtg-ai/claude-squad | AGPL-3.0 | tmux session + git worktree per agent (Claude Code, Codex, Gemini, Aider, OpenCode, Amp); pause/resume, yolo mode, review before push. Terminal-first multi-agent control. |
| **Conductor** (Mac app), **LaneConductor** | various | https://github.com/meller/laneconductor ; review https://markferree.substack.com/p/agent-orchestration-for-the-timid | LaneConductor OSS | Isolated workspace per agent; LaneConductor adds Plan → Implement → Review → Quality Gate → Done pipeline on a kanban. |
| **Research: AgentGUI, IBM Agent Trajectory Explorer** | academic | https://www.alphaxiv.org/abs/2607.26300 , https://research.ibm.com/publications/agent-trajectory-explorer-visualizing-and-providing-feedback-on-agent-trajectories | papers | Interfaces for observing/steering long-running agents and giving feedback on trajectories. |

Common visualization primitives across these: (1) trace tree (turn → LLM call → tool call → subagent), (2) linear trajectory/timeline with action vs observation coloring, (3) diff review with accept/reject, (4) live status line (context %, cost, active tool), (5) multi-session board (kanban/sessions list with state), (6) permission/policy decision cards.

---

## 4. Guardrails and agent safety

| Resource | Org | Link | OSS? | Summary / relevance |
|---|---|---|---|---|
| **Claude Code permissions + PreToolUse hooks** | Anthropic | https://code.claude.com/docs/en/hooks.md | n/a | `permissionDecision` allow/deny/ask/defer, `updatedInput` rewrite, exit 2 blocks, `onFailure: "block"` for fail-closed, `if: "Bash(rm *)"` matchers. Precedence: deny rules win over hook `allow` (fixed in v2.1.77 per https://claudeissues.com/issue/35136-docs-hook-docs-imply-pretooluse-allow-can-override-deny-rules ); several historical issues of deny not enforced for MCP/Edit tools (https://claudeissues.com/issue/33106-pretooluse-hook-permissiondecision-deny-not-enforced-for-mcp-server-tool-calls ) — so qharness must not rely solely on hooks. Hooks still run under `--dangerously-skip-permissions` (secondary). |
| **Claude Code sandboxing** | Anthropic | https://code.claude.com/docs/en/sandboxing.md | `@anthropic-ai/sandbox-runtime` OSS | macOS Seatbelt / Linux bubblewrap + network namespace; write allow-list, protected paths (`.claude`, `.git/hooks`, shell rc), domain-allowlisted proxy, credential deny/mask, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `excludedCommands`. Hooks/MCP servers/mods run **outside** the sandbox. Reuse `sandbox-runtime` for OpenCode too. |
| **OpenCode `permission.ask` / `tool.execute.before`** | anomalyco + community | https://opencode.ai/docs/plugins/ ; damage-control plugin https://gh.r-mj.com/whjvenyl/opencode-damage-control | OSS | Plugin can force ask/deny and rewrite tool args; a community plugin implements rm/sudo guards. |
| **ACP `session/request_permission`** | Zed | https://agentclientprotocol.com/protocol/tool-calls | OSS spec | Client-side interception point that works for *any* ACP agent; agent owns `allow_always` memory. Caveat: some agents auto-approve and never ask (Copilot CLI issue https://github.com/github/copilot-cli/issues/845 ). |
| **Invariant Guardrails / Gateway / MCP-scan** | Invariant Labs (acquired by Snyk, 2025) | https://github.com/invariantlabs-ai/invariant , https://invariantlabs.ai/blog/guardrails , https://pypi.org/project/mcp-scan/ | Apache 2.0 | Python-like policy language over *traces*: e.g. "raise if `send_email` follows `get_website` output with prompt-injection score > 0.7"; flow constraints (read inbox → email outside domain), content rules, prompt-injection detector; enforced in Gateway proxy, as MCP proxy, or offline over a trace. MCP-scan detects tool poisoning/rug-pulls; reportedly rebranded Snyk Agent Scan (secondary). Best model for qharness's policy engine: policies over the tool-call *sequence*, not single calls. |
| **NeMo Guardrails** | NVIDIA | https://github.com/NVIDIA/NeMo-Guardrails | Apache 2.0 | Input, dialog, retrieval, **execution** (tool input/output) and output rails in Colang. Execution rails are the relevant concept; heavy for a coding-agent harness. |
| **Guardrails AI** | Guardrails AI | https://github.com/guardrails-ai/guardrails | Apache 2.0 | Validator hub (regex, toxicity, competitor, PII…) composed into input/output Guards; server mode with OpenAI-compatible endpoint. Hosted inference being discontinued (Aug 2026). Useful as validators on the model path, not on tool execution. |
| **Llama Guard 4** | Meta | comparisons: https://blog.premai.io/production-llm-guardrails-nemo-guardrails-ai-llama-guard-compared , https://www.digitalapplied.com/blog/llm-guardrails-production-safety-layers-reference-2026 | community license | Content-safety classifier model; usually paired with NeMo. Low relevance for code-agent tool safety. |
| **LiteLLM / Portkey / Kong guardrails** | see §1 | — | — | Model-path PII/secret/injection checks; `logging_only` mode is a good non-blocking default. |
| **Anthropic: Building effective agents** (Dec 2024) | Anthropic | https://www.anthropic.com/engineering/building-effective-agents | — | Agents = LLM + tools in a loop with environmental feedback; add human checkpoints, stopping conditions (max iterations), sandboxed testing, separate screening model, ACI (tool) design: absolute paths, poka-yoke tool schemas. |
| **Anthropic: Effective harnesses for long-running agents** (Nov 26 2025) | Anthropic | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents | — | See §5; verification-before-"passes" is a guardrail. |
| **OpenAI: A practical guide to building agents** (Apr 2025) | OpenAI | https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf (via summaries https://www.maginative.com/article/how-to-build-ai-agents-a-detailed-practical-guide-from-openai/ ) | — | Layered guardrails (relevance/safety classifiers, PII filters, moderation, tool-risk rating, rules-based blocklists, output validation) plus human-in-the-loop for high-risk actions and repeated failures. |
| **Destructive-command guards in practice** | community | https://pasqualepillitteri.it/en/news/1832/claude-code-dangerously-skip-permissions-pretooluse-hooks-2026 ; Anthropic `blast-radius` mod https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius | OSS | Bash PreToolUse hook blocking `rm -rf`, `sudo`, force-push; the mod variant *holds* the call and shows impact with proceed/cancel buttons. |

Layering that emerges: (a) OS sandbox (what a process *can* touch) → (b) client-side permission policy at ACP/hook level (whether a tool call *runs*) → (c) sequence/data-flow policy à la Invariant (whether this call is acceptable *given prior calls*) → (d) model-path content guardrails (PII/secrets/injection) → (e) human checkpoint with full context. qharness Guardrails should implement (b) and (c) itself and delegate (a) and (d).

---

## 5. Looping and orchestration control planes

| Resource | Org | Link | OSS? | Summary / relevance |
|---|---|---|---|---|
| **Effective harnesses for long-running agents** | Anthropic (Justin Young, 2025-11-26) | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents | — | Initializer agent (init.sh, progress file, first commit, JSON feature list, all `passes: false`) then repeated coding sessions: re-orient (git log, progress notes, feature list), one feature per session, verify end-to-end (browser automation) before flipping `passes`, end in clean mergeable state + commit + progress update. Failure modes: over-ambition and premature "done". This is the canonical spec for qharness Looping: machine-readable task state outside the context window + per-iteration ritual + verification gate. |
| **Ralph Wiggum loop / ralph-loop plugin** | Geoffrey Huntley; Anthropic official plugin | https://shipyard.build/blog/claude-code-ralph-loop/ , https://developer.tenten.co/ralph-wiggum-plugin-turning-claude-code-into-an-autonomous-development-agent , https://github.com/dial481/ralph | OSS | `while :; do cat PROMPT.md | claude; done` formalized as a Stop hook that re-prompts until a completion promise or `--max-iterations`. Cheap outer loop; qharness should generalize it: iteration budget, completion predicate, cost cap, stuck detection. |
| **Claude Code scheduled tasks (formerly routines)** | Anthropic | https://code.claude.com/docs/en/routines.md | SaaS (research preview) | Saved prompt + repos + connectors run on Anthropic cloud or self-hosted environment; triggers: cron schedule / one-shot time, HTTP POST with bearer token, GitHub events; `/schedule` in CLI, UI at claude.ai/code/routines; Pro/Max/Ultra/Team/Enterprise. Local counterparts: `/loop` and Desktop scheduled tasks. qharness can be the self-hosted equivalent with full telemetry. |
| **OpenAI Codex cloud** | OpenAI | https://learn.chatgpt.com/docs/cloud | SaaS | Published environments (install script, start skill, env vars, network policy: all / package managers / allow-list), each task in its own workspace running in parallel, review diffs + tests, commit or open PR; CLI can list cloud chats and status. Benchmark for "environment definition + per-task isolation + review". |
| **Temporal** | Temporal | https://docs.temporal.io/develop/python/integrations/openai-agents , https://docs.temporal.io/ai/cookbook/human-in-the-loop-python.md | OSS server (MIT) + cloud | Agent loop as Workflow, each model/tool/MCP call as Activity (retries, timeouts, history replay); human approval via Signals; OpenAI Agents SDK integration GA (Mar 2026). Durable history doubles as an audit trace. Heavy but proven for long loops across restarts. |
| **Inngest / AgentKit** | Inngest | https://agentkit.inngest.com/ | OSS SDK + cloud/self-host | Agents/Networks/Routers with shared Network State; `step.run` durable boundaries; live traces in Dev Server; MCP tools, E2B/Daytona sandboxes. Lighter than Temporal; event-driven fits "GitHub event → run". |
| **Restate** | Restate | https://thenextweb.com/news/restate-20m-series-a-singular-durable-execution-ai-agents (news), Pydantic AI integration https://pydantic.dev/docs/ai/durable-execution/overview/ | OSS + cloud | Durable execution with journaled steps and suspensions, serverless-first; Pydantic AI lists Temporal and Restate as durable backends. |
| **Vercel WorkflowAgent / OpenAI Agents SDK RunState / Mastra approvals** | various | https://vercel.com/kb/guide/what-is-workflowagent , https://www.zenml.io/blog/openai-agents-sdk-durable-runtime , https://mastra.ai/docs/agents/agent-approval | mixed | Patterns for "pause on `needsApproval`, serialize run state, resume later" — the same shape qharness needs when an ACP `request_permission` must wait for a human for hours. |
| **Multi-agent runners** | Vibe Kanban, Claude Squad, LaneConductor | §3 | OSS | Worktree-per-task + agent process lifecycle (create/prompt/pause/resume/delete). |

---

## Recommended observability stack for qharness

1. **Make ACP the single source of truth for execution events.** Normalize every `session/update` (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, mode change, compaction) and every `session/request_permission` + outcome into one append-only event log per session (JSONL first, SQLite/DuckDB index second). Keep `rawInput`/`rawOutput` behind a redaction flag, mirroring Claude Code's `OTEL_LOG_TOOL_DETAILS`/`OTEL_LOG_TOOL_CONTENT` defaults-off posture.

2. **Also ingest the agents' native telemetry and reconcile, don't replace it.** For Claude Code, enable OTLP metrics+logs (+beta traces) pointed at qharness's collector and join on `session.id`, `prompt.id`, `tool_use_id`, `request_id`; this is the only way to get per-request `cost_usd`, cache tokens, `tool_decision.source`, `api_refusal`, and subagent spans that ACP does not carry. For OpenCode, read `opencode.db` read-only (or a small logger plugin) for the same fields. Fall back to the Claude Code transcript JSONL only for debugging (undocumented format).

3. **Adopt the OTel GenAI semantic conventions as the trace schema**, emitted by qharness itself: root `invoke_agent {agent}` per session turn (`gen_ai.agent.name` = claude-code|opencode, `gen_ai.conversation.id` = ACP sessionId), child `chat {model}` spans (from native telemetry when available), child `execute_tool {gen_ai.tool.name}` spans built from ACP `tool_call`→`tool_call_update` with `gen_ai.tool.call.id` = `toolCallId`, plus qharness-specific attributes: `qharness.tool.kind` (ACP `kind`), `qharness.tool.status`, `qharness.permission.outcome`, `qharness.policy.rule_id`, `qharness.loop.iteration`, `qharness.worktree`, `vcs.repository.url.full`, `vcs.ref.head.name`. Track the semconv repo; it is still in Development status.

4. **Propagate W3C trace context into the agent.** Set `TRACEPARENT`/`traceparent` for the agent subprocess (Claude Code forwards it to Bash subprocesses and, with `CLAUDE_CODE_PROPAGATE_TRACEPARENT=1`, to a custom `ANTHROPIC_BASE_URL`), and pass qharness's trace id via ACP `_meta` so hook-based exporters (e.g. Langfuse's `CC_LANGFUSE_TRACEPARENT`) nest under the harness span.

5. **Log at four levels with explicit retention:** (a) metrics: tokens by type, USD cost, tool-call count by kind/status, permission asks/denies, loop iterations, wall time, lines added/removed, commits/PRs; (b) events: one row per ACP update and per policy decision; (c) traces: the GenAI span tree; (d) artifacts: diffs (ACP `diff` content), terminal output (`terminal` content), the feature-list/progress files from the loop. Keep (a)–(c) long-term with content redacted, (d) short-term or opt-in.

6. **Reuse Langfuse (OSS, self-hosted) as the default trace/session store and UI**, fed over OTLP, with the existing Claude Code and OpenCode integrations as a bridge; offer Arize Phoenix (ELv2, OpenInference) as the alternative and plain OTLP to SigNoz/Grafana/Datadog for teams with an existing stack. Do not build a general trace explorer.

7. **Reuse OpenLLMetry instrumentation inside the optional model proxy.** If qharness offers an `ANTHROPIC_BASE_URL`/OpenAI-compatible proxy for API-key users, build it on LiteLLM (virtual keys, budgets, `logging_only` guardrails) or Bifrost (Go, MCP gateway) rather than writing routing/budget code; instrument with OpenLLMetry so `chat` spans match the GenAI conventions.

8. **Build the policy engine in-house, Invariant-style.** Evaluate rules over the *sequence* of ACP tool calls in a session (data-flow: e.g. "fetched untrusted content → later `execute`/`edit` outside worktree → ask"; destructive patterns: `rm -rf`, `git push --force`, `DROP`, credential paths; scope: writes outside the worktree), returning allow/ask/deny/rewrite. Enforce it at `session/request_permission` (works for any ACP agent) and mirror it as a Claude Code PreToolUse hook / OpenCode `permission.ask` plugin for defence in depth, because agents may not ask (Copilot CLI issue) and hook enforcement has had gaps. Record every decision as a `qharness.policy` span event.

9. **Delegate OS isolation.** Run agents inside `@anthropic-ai/sandbox-runtime` (Seatbelt/bubblewrap, domain-allowlisted proxy, credential masking) or a container per worktree; qharness configures `allowWrite`/`allowedDomains` from the task definition and records the sandbox profile on the session span. Remember hooks/MCP servers/mods execute outside the sandbox.

10. **Looping: implement the Anthropic long-running-harness contract as data, not prompts.** Per task: `init` step (environment script, baseline test, first commit), machine-readable feature list with `passes` flags that only a verification step may flip, progress log, per-iteration ritual (re-orient → one feature → verify → commit → update progress). Loop controller tracks `iteration`, cost-so-far, no-progress streak (no diff / same failing test), and completion predicate; stop conditions and budgets are first-class and visible in the UI. Ralph-style Stop-hook re-prompting becomes one strategy among several.

11. **Make the loop durable.** Persist loop state (iteration, feature list hash, last commit, pending permission requests) so a crash or a day-long human approval resumes cleanly; start with SQLite + idempotent steps, keep an adapter boundary so Temporal or Inngest can host the same loop when running many tasks or reacting to GitHub events (the Codex cloud / Claude scheduled-tasks trigger set: cron, HTTP, GitHub).

12. **Visualization: ship three views, borrow the rest.** (i) Live session view = Zed Agent Panel baseline (streaming tool cards with `kind`/`status`, diff review, terminal, permission cards) plus a claude-hud-style status strip (context %, cost, active tool, iteration). (ii) Trajectory replay = OpenHands-style action/observation timeline over the event log, with `/replay` of edits. (iii) Fleet board = Vibe Kanban/Devin-style sessions list by state (running, waiting-for-human, failed, done) with cost and policy denials per session. Deep trace trees and search stay in Langfuse/Phoenix.

13. **Cost attribution.** Compute cost from native `claude_code.cost.usage` / `api_request` events when present, otherwise from token counts × a maintained price table (ccusage approach); roll up per session, task, worktree, repo and day, and expose the 5-hour subscription window for Claude Code users.

14. **Privacy defaults.** Metadata-only by default (tool names, kinds, sizes, durations, decisions, hashes of paths); prompt/response/tool content opt-in per project, with `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`-style truncation and a secret scrubber before export. Follow Langfuse's recommendation that hook/plugin telemetry is observability, not compliance; enforcement lives in the ACP gateway and the sandbox.

15. **Evals later, on top of the same traces.** Because everything is OTel/Langfuse-shaped, Braintrust, Laminar "Signals", or Phoenix evals can score sessions (task completed? tests green? policy denials?) without new instrumentation; design the event schema now so a session can be exported as a dataset row.
