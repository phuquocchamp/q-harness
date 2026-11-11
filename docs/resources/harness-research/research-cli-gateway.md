# Research: a CLI + Skills gateway for coding agents (qharness)

Date: 2026-11-09. Scope: how an outer harness ("qharness") that talks to coding agents over ACP can expose developer CLIs (supabase, vercel, kubectl, gh, bitbucket, jenkins) and reusable skills to Claude Code, OpenCode and other ACP agents. Only sources that were actually opened or returned by search are cited.

---

## 1. Protocols

### 1.1 Agent Client Protocol (ACP)

**Agent Client Protocol** -- Zed Industries / agentclientprotocol org -- https://agentclientprotocol.com/overview/introduction , https://github.com/agentclientprotocol/agent-client-protocol
JSON-RPC protocol between an editor/harness ("Client") and a coding agent ("Agent"), analogous to LSP. Local agents run as subprocesses over stdio; remote (HTTP/WebSocket) support is in progress. Reuses MCP JSON types where possible. Stable protocol version is `1`; schema artifacts exist for `v1` and `v2`. SDKs: Rust, TypeScript (`@agentclientprotocol/sdk`), Python, Kotlin, Java. Apache-2.0.
Relevance: this is qharness's wire protocol; everything below has to fit through it.

**Session setup / passing MCP servers** -- https://agentclientprotocol.com/protocol/session-setup
`session/new` takes `cwd` and a required `mcpServers` array. Transports: `stdio` (every agent must support it: `name`, `command` (absolute path), `args`, `env` as `{name,value}` list), `http` (`url`, `headers`) and deprecated `sse`, each gated by `agentCapabilities.mcpCapabilities.http/sse`. Spec text: "Clients may also supply their own MCP server to give tools directly to the model." Clients should get user approval for stdio servers that come from workspace files or agent output, and agents must not log `env`/`headers` values.
Relevance: **this is the sanctioned hook for a harness to inject a tool gateway into any ACP agent** -- the gateway is just an MCP server listed in `mcpServers`.

**Architecture page (client-exported MCP tools)** -- https://agentclientprotocol.com/get-started/architecture (via Context7 `/websites/agentclientprotocol`)
"The code editor may itself also wish to export MCP based tools. Instead of trying to run MCP and ACP on the same socket, the code editor can provide its own MCP server as configuration. As agents may only support MCP over stdio, the code editor can provide a small proxy that tunnels requests back to itself."
Relevance: the official pattern = small stdio shim in `mcpServers` that tunnels to the harness process.

**Initialization / capabilities** -- https://agentclientprotocol.com/protocol/initialization
Client capabilities: `fs.readTextFile`, `fs.writeTextFile`, `terminal`. Agent capabilities: `loadSession`, `mcpCapabilities.http/sse`, `promptCapabilities` (image, audio, embeddedContext). Anything omitted is unsupported.

**Terminals (v1)** -- https://agentclientprotocol.com/protocol/terminals
In v1 the *Client* implements `terminal/create|output|wait_for_exit|kill|release`; the agent calls them to run shell commands in the client's environment when `clientCapabilities.terminal: true`. Spec: the client runs the commands and "must apply its own checks"; it should keep `cwd` in the session roots and apply policy to the full command, args and env.
Relevance: in v1, a harness that advertises `terminal` **sees and executes every shell command the agent wants to run** -- a natural interception point for CLI allowlists. The Claude adapter supports "interactive and background terminals".

**ACP v2 migration (important caveat)** -- https://agentclientprotocol.com/protocol/v2/migration (via Context7)
v2 *removes* `clientCapabilities.fs` and `clientCapabilities.terminal` and all `terminal/*` and `fs/*` methods: "Clients that want to expose file access, unsaved editor state, or command execution to agents should do so by providing an MCP server to the session (via `mcpServers` on `session/new` / `session/resume`)". The `claude-agent-acp` adapter says its v2 support is "experimental ... can still change."
Relevance: do not build the gateway on client terminals; build it as an MCP server, which works in v1 and v2.

**Tool calls and permissions** -- https://agentclientprotocol.com/protocol/tool-calls
Agents report `tool_call` / `tool_call_update` with `kind` (read, edit, delete, move, search, execute, think, fetch, switch_mode, other), `status`, `locations`, `rawInput`/`rawOutput`, diffs or a `terminalId`. `session/request_permission` sends options with kinds `allow_once | allow_always | reject_once | reject_always`; "Clients may allow or reject requests automatically based on user settings." The agent owns remembered decisions.
Relevance: qharness can auto-answer permission prompts per policy, and gets an audit stream of every tool call regardless of whether the tool is MCP or Bash.

**Extensibility** -- https://agentclientprotocol.com/protocol/extensibility
`_meta` key-value maps on most objects, custom methods prefixed `_` (reverse-DNS names such as `_com.example/foo`), capability advertisement through `_meta` in capability objects.
Relevance: room for qharness-specific metadata (e.g., tagging a tool call with the gateway policy decision).

**Agents implementing ACP** -- https://agentclientprotocol.com/overview/agents
~50 listed. Relevant ones: Claude Agent via Zed's adapter (`claude-agent-acp`), OpenCode (native `opencode acp`), Gemini CLI (reference implementation), Codex CLI via `codex-acp`, GitHub Copilot CLI (public preview since 2026-01), Goose, Cursor, Kiro, Qwen Code, Kimi CLI, Mistral Vibe, OpenHands, Docker cagent, Pi (via `pi-acp`), Augment, Factory Droid, JetBrains Junie, Cline.

**claude-agent-acp (formerly claude-code-acp)** -- Zed Industries -- https://github.com/zed-industries/claude-code-acp (redirects to claude-agent-acp)
Implements an ACP agent with the official Claude Agent SDK; ships bundled with the `claude` binary or uses `CLAUDE_CODE_EXECUTABLE`. Supports client-provided MCP servers, `/mcp` status/reconnect/enable/disable via the SDK control API, MCP OAuth via URL elicitation, permission requests (with a permission extension), custom slash commands, interactive/background terminals, subagent transcripts. Caveat: as of 2026-04 Anthropic blocked subscription OAuth from third-party harnesses (cookbook note found in search); the Agent SDK docs say third parties must use API-key auth.
Relevance: qharness's path to Claude Code. There is no evidence of a native `claude --acp` flag; the adapter is the supported route.

**Zed blog: Claude Code via ACP** -- https://zed.dev/blog/claude-code-via-acp
Adapter wraps the SDK and translates to ACP JSON-RPC; Claude Code runs as an independent process; limited to what the SDK exposes.

**codex-acp** -- agentclientprotocol org -- https://github.com/agentclientprotocol/codex-acp
Stdio ACP agent that starts the Codex App Server. Accepts client-provided MCP servers (stdio or HTTP), `/mcp reconnect`, approval/sandbox selected via `INITIAL_AGENT_MODE` (`read-only`, `workspace-write`, `agent`, `agent-full-access`, `permission-profile:<id>`). Apache-2.0, npm `@agentclientprotocol/codex-acp`.

**OpenCode ACP** -- SST -- https://docs.opencode.ai/docs/acp/
`opencode acp` runs OpenCode as an ACP subprocess over stdio. Supports MCP servers from the OpenCode config, custom tools, AGENTS.md, agents and permissions; `/undo`, `/redo` unsupported. The page does not document handling of client-provided `mcpServers`; verify empirically.

**Gemini CLI in Zed** -- https://zed.dev/acp/agent/gemini-cli
Zed installs `@google/gemini-cli` and talks ACP to it; Gemini CLI is the ACP reference implementation (Zed launch post: https://zed.dev/blog/bring-your-own-agent-to-zed). The exact CLI flag was not confirmed in official docs.

### 1.2 MCP as the tool-exposure standard

**MCP specification 2025-11-25, tool annotations** -- modelcontextprotocol.io (via Context7 `/websites/modelcontextprotocol_io_specification_2025-11-25`)
`ToolAnnotations`: `readOnlyHint` (default false), `destructiveHint` (default true), `idempotentHint` (default false), `openWorldHint` (default true). "All properties in ToolAnnotations are hints ... Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers."
Relevance: a gateway that *you* control can set these honestly; Claude Code's plan mode and auto-mode classifier already treat "MCP tools their server marks read-only" differently.

**Claude Code MCP docs** -- Anthropic -- https://code.claude.com/docs/en/mcp
Scopes local/project/user (precedence local > project > user > plugin > connectors). Transports http (recommended), sse (deprecated), stdio, ws. `--mcp-config <file-or-json>` adds servers to a session; `--strict-mcp-config` uses only those. Tool names `mcp__<server>__<tool>` (plugins: `mcp__plugin_<plugin>_<server>__<tool>`). Output limits: warn at 10k tokens, default max 25k (`MAX_MCP_OUTPUT_TOKENS`), text results >50k chars saved to a file; servers can raise it per tool with `_meta["anthropic/maxResultSizeChars"]` (cap 500k). `headersHelper` runs a command to mint short-lived headers per connection (10 s limit). **MCP tool search** is on by default: only tool names and server instructions load at start; `ENABLE_TOOL_SEARCH` = unset/true (defer), `auto` (defer once definitions exceed 10% of context), `auto:N`, `false`. Per-tool `_meta["anthropic/alwaysLoad"]` and per-server `alwaysLoad` control deferral. Description limits: 4,096 chars upfront, 16,384 when loaded through tool search. `_meta["anthropic/requiresUserInteraction"]` forces a prompt even with an allow rule.

**Anthropic Tool Search Tool (API)** -- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
Server-side regex/BM25 search over deferred tools (`defer_loading: true`); a multi-server setup "can consume ~55k tokens in definitions"; selection accuracy "degrades once you exceed 30-50 available tools"; recommended when you have 10+ tools or aggregate 200+ MCP tools. Supports custom client-side search returning `tool_reference` blocks.

**Anthropic: Code execution with MCP** -- https://www.anthropic.com/engineering/code-execution-with-mcp
Present MCP servers as a filesystem of code APIs; agent reads only the wrappers it needs; a workflow dropped from ~150k to ~2k tokens (98.7%). Also: data filtering in code, control flow in code, PII tokenization, saving working code as SKILL.md-backed skills. Trade-off: requires a sandbox, resource limits and monitoring.

### 1.3 Agent Skills (SKILL.md)

**Agent Skills specification** -- originally Anthropic, open standard -- https://agentskills.io/specification , https://agentskills.io/
Directory with `SKILL.md` (YAML frontmatter + Markdown) plus optional `scripts/`, `references/`, `assets/`. Frontmatter: `name` (1-64 chars, lowercase/digits/hyphens, must equal directory name), `description` (1-1024 chars), optional `license`, `compatibility`, `metadata`, experimental `allowed-tools` (e.g. `Bash(git:*) Bash(jq:*) Read`). Progressive disclosure: metadata (~100 tokens) at startup, body (<5k tokens recommended, <500 lines) on activation, resources on demand. Validator: `skills-ref validate`.
Relevance: the portable unit for "how to use CLI X safely" that both Claude Code and OpenCode load.

**Claude Code skills** -- https://code.claude.com/docs/en/skills
Locations: enterprise, `~/.claude/skills/`, `.claude/skills/`, nested `<subdir>/.claude/skills/`, `.claude/skills/` inside `--add-dir` directories (session-only), plugin `skills/`, claude.ai synced. Extra frontmatter: `when_to_use`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `context: fork` + `agent`, `model`, `effort`, `paths`, `hooks`, `argument-hint`/`arguments`. Dynamic context via `` !`command` ``. Permission rules `Skill(name)`/`Skill(name *)`; `skillOverrides` setting. Skill bodies are re-attached after compaction with budgets.

**OpenCode skills** -- https://opencode.ai/docs/skills/
Reads `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, `.opencode/skills`, `.claude/skills`, `.agents/skills` (walking up to project root), plus `skills` entries in `opencode.json` (local folders or HTTP catalogs). Skill ID comes from path; model loads via the `skill` tool or `@skill-id`. Permission action `skill` with allow/ask/deny.
Relevance: one `.claude/skills/` tree (or an `--add-dir`-style directory) serves both agents.

---

## 2. Existing CLI-to-agent gateways

### 2.1 Vendor MCP servers for the target services

**GitHub MCP Server** -- GitHub -- https://github.com/github/github-mcp-server
Remote at `api.githubcopilot.com/mcp/` (OAuth) or local Docker/binary (PAT or device-code OAuth; required for GHES). Toolsets (`repos`, `issues`, `pull_requests`, `actions`, `code_security`, ...) via `--toolsets`/`--tools`; `--read-only` drops write tools. Does **not** wrap `gh`; talks to the API. ~43-93 tools depending on config (third-party counts), which is the canonical "schema bloat" example.

**Kubernetes MCP Server** -- containers org (Red Hat) -- https://github.com/containers/kubernetes-mcp-server
Go native client of the API server, no kubectl needed. Toolsets `config`, `core` default; optional `helm`, `kubevirt`, `tekton`, observability. `read_only` and `denied_resources` are "best-effort"; rely on RBAC of the kubeconfig identity. OAuth/OIDC in HTTP mode.

**Supabase MCP** -- Supabase community/official -- https://github.com/supabase-community/supabase-mcp
Hosted server with OAuth 2.1; `read_only=true`, `project_ref=` scoping, `features=` groups (`database,docs`, ...). Local CLI/self-hosted variants have a reduced tool set and no OAuth 2.1. Docs point to security best practices on prompt injection.

**Vercel MCP** -- Vercel -- https://vercel.com/docs/agent-resources/vercel-mcp
Remote `https://mcp.vercel.com`, OAuth + Streamable HTTP, CIMD client registration; tools for docs, projects, deployments, logs, analytics, now also deploy. Clients must be CIMD-based or reviewed by Vercel. Explicit guidance: enable human confirmation, beware confused-deputy and prompt injection. Setup snippets for Claude Code (`claude mcp add --transport http vercel https://mcp.vercel.com`) and OpenCode (`{"type":"remote","url":...}`).

**Jenkins MCP Server plugin** -- Jenkins project (maintainers Yi Gong, Olivier Lamy) -- https://plugins.jenkins.io/mcp-server/
Server-side plugin exposing Streamable HTTP at `<jenkins>/mcp-server/mcp` (plus SSE, stateless). Tools: jobs (list/get/create/trigger/cancel), builds (details, logs, search logs, rebuild, replay, test results), SCM lookups, management. Auth: Jenkins user API token over HTTP Basic. The only Jenkins-side option; community wrappers also exist (e.g. `avisangle/jenkins-mcp-server`, `NithishNithi/go-jenkins-mcp` found via https://mcpservers.org/servers/nithishnithi/go-jenkins-mcp).

**Atlassian Rovo MCP Server** -- Atlassian -- https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/ , Bitbucket announcement https://community.atlassian.com/forums/Bitbucket-articles/Bitbucket-Cloud-is-now-available-on-the-Atlassian-Rovo-MCP/ba-p/3218447
Endpoint `https://mcp.atlassian.com/v2/mcp`, OAuth 2.1 (API token optional); Jira, JSM, Confluence, **Bitbucket Cloud** (added ~2026-04). Gateways can append `?tools=all` for a flat paginated tool list instead of discover/execute meta-tools. Some third-party guides say Bitbucket tools are API-token-only; verify. Community alternatives: `@aashari/mcp-server-atlassian-bitbucket` (npm), `atlassian-bitbucket-mcp` (PyPI), `bb` CLI (below).

### 2.2 Generic shell-to-MCP bridges

**shell-mcp** -- devrelopers -- https://github.com/devrelopers/shell-mcp
Rust MCP server with `shell_exec` + `shell_describe`. Hard denylist (sudo, `rm -rf /`) checked first; rejects shell metacharacters; direct exec with discrete args ("no shell is invoked"); read-only default allowlist; writes via `.shell-mcp.toml` discovered git-style; `*`/`**` arg patterns; cwd confined to launch root; 200-line/8 KB per-stream clipping with `truncated` flag; rejection names the layer. v0.1, MIT, tiny community.
Relevance: the closest existing design to a "typed-ish allowlisted CLI runner"; a good reference even if you do not adopt it.

**mcp-unix-shell** -- gamunu -- https://mcpservers.org/en/servers/gamunu/mcp-unix-shell -- Go, allowlist via flag, Apache-2.0.
**mcp-shell-server** -- tumf -- https://awesome.ecosyste.ms/api/v1/projects/github.com%2Ftumf%2Fmcp-shell-server -- Python, allowlist via env var.
Relevance: simpler allowlist bridges; demonstrate the pattern but with weaker metacharacter handling.

### 2.3 MCP gateways / aggregators

**Docker MCP Gateway** -- Docker -- https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/ , https://github.com/docker/mcp-gateway , CLI ref https://docs.docker.com/reference/cli/docker/mcp/gateway/run/
`docker mcp gateway run` (stdio default, or `--transport streaming --port`). Each catalog server runs in its own container (`--cpus 1`, `--memory 2Gb` defaults), secrets injected from Docker Desktop secrets or `.env` (`--secrets`), `--block-secrets` (default true) stops secrets leaking in/out of tool traffic, `--block-network`, `--verify-signatures`, `--log-calls`, OCI catalogs and profiles, per-tool enable/disable, OAuth flows. `--interceptor when:type:path` (e.g. `before:exec:/bin/path`, `after:exec`, `around:http`) is beta: before-interceptors can reject and answer a call, after-interceptors rewrite the result. MIT. Relevance: strongest open-source model of "gateway = isolation + secret brokering + policy interceptors".

**IBM ContextForge** -- IBM -- https://github.com/IBM/mcp-context-forge
Federates MCP, A2A, REST and gRPC behind one endpoint; REST-to-MCP with schema extraction, retries, timeouts, rate limits; virtual servers bundling selected tools; JWT/Basic/OAuth; admin UI; plugins; OpenTelemetry. Heavier, enterprise-registry shape.

**Lasso MCP Gateway** -- Lasso Security -- https://github.com/lasso-security/mcp-gateway
Python proxy that exposes only two tools (`get_metadata`, `run_tool`) and sanitizes requests/responses via plugins (`basic` secret masking, `presidio` PII, `lasso` API guardrails, `xetrack` tracing); `--scan` blocks servers with low reputation. Config is an `mcp.json`. Relevance: the "two meta-tools" shape is itself a progressive-disclosure technique.

**MetaMCP** -- metatool-ai -- https://github.com/metatool-ai/metatool-app (now metamcp)
Aggregates servers into namespaces exposed over SSE/Streamable HTTP/OpenAPI; per-namespace tool toggles, name/description overrides, custom annotations (e.g. `readOnlyHint`), middleware, API-key/OAuth/OIDC, rate limiting. Maintenance described as delayed by the author; MIT, ~2.8k stars.

**Microsoft MCP Gateway** -- Microsoft -- https://github.com/microsoft/mcp-gateway
Kubernetes reverse proxy/lifecycle manager; Entra ID bearer auth; requires MCP `2026-07-28` clients (no legacy init). Azure-shaped; costly to adapt elsewhere.

**Obot** -- Obot Platform -- https://github.com/obot-platform/obot
Governance platform: catalogs (MCP Registry API), virtual MCP servers pinned to catalog snapshots, hosted servers as Docker/K8s workloads, OpenAPI-to-MCP, RBAC per user/IdP group, SCIM, credential storage, audit export. Kubernetes for production.

**mcp-proxy** -- sparfenyuk -- https://github.com/sparfenyuk/mcp-proxy
Bridges stdio <-> SSE/Streamable HTTP in both directions; "named servers" mode hosts many stdio servers under `/servers/<name>/`. Relevance: the simplest building block for the "stdio shim that tunnels back to the harness" pattern ACP recommends.

**Gateway comparison round-ups** -- Zuplo https://zuplo.com/blog/mcp-gateway-comparison (Zuplo, Lunar MCPX, Composio, Kong, TrueFoundry, Operant, Portkey, Lasso, Usercentrics, Workato); also vendor-leaning lists at https://www.arcade.dev/blog/best-mcp-gateways-enterprise/ , https://obot.ai/blog/the-13-best-mcp-gateways-for-enterprise-teams/ , https://vdf.ai/blog/mcp-gateway-comparison/ , https://dev.to/sebuzdugan/5-best-mcp-gateways-in-2026-bifrost-ibm-contextforge-obot-docker-and-microsoft-compared-3aef . Treat as vendor framing.

### 2.4 Tool routers (hosted)

**Composio Tool Router** -- Composio -- https://docs.composio.dev/docs/how-composio-works , https://docs.composio.dev/tool-router/using-with-mcp-clients , https://docs.composio.dev/kb/guide/mcp-tool-router-sessions.md
Per-user *sessions* each exposing a unique MCP URL + headers; default is meta-tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MANAGE_CONNECTIONS`) for dynamic discovery, or a direct-tools preset; Composio-managed OAuth created on demand; 1,000+ toolkits (vendor claim). Relevance: reference for "session-scoped MCP URL + search meta-tool + managed auth".

**Arcade.dev** -- https://docs.arcade.dev/en/home
Actions runtime with per-user OAuth token storage ("zero token exposure"), per-action authorization, registers external MCP servers under one control plane, OpenTelemetry audit, Helm self-hosting; smaller catalog than Composio.

**Toolhouse** -- https://docs.toolhouse.ai/
Now positioned as "AI workers" platform; tool store/MCP details not on the landing page. Low relevance.

### 2.5 "Let the agent call CLIs via Bash with allowlists"

**Claude Code permissions** -- https://code.claude.com/docs/en/permissions
Rules `allow`/`ask`/`deny`; deny beats allow, ask beats allow. Bash rules match whole command text with prefix wildcards (`Bash(git log *)`, `:*` suffix); compound commands split on `&&`, `||`, `;`, `|`, `|&`, `&`, newline and every part must be allowed; deny/ask match nested subshells and `$(...)`; known wrappers (`timeout`, `nice`, `nohup`, `xargs` bare, `command`) stripped; `npx`, `docker exec`, `devbox run` are **not** stripped, so `Bash(devbox run *)` is a hole; `/usr/bin/curl` and `sh -c '...'` evade `Bash(curl *)`; argument-constraining patterns are called "fragile"; redirects and `tee` targets are checked against Edit rules. MCP rules: `mcp__server`, `mcp__server__*`, `mcp__server__tool`; parenthesised MCP parameter rules in settings are skipped (use `--disallowedTools`). PreToolUse hook `allow` cannot override deny/ask rules.

**Claude Code permission modes** -- https://code.claude.com/docs/en/permission-modes
`default`, `acceptEdits`, `plan`, `auto` (classifier reviews; blocks `curl | bash`, prod deploys/migrations, force push, `terraform destroy`; drops broad rules like `Bash(*)` on entry), `dontAsk` (deny instead of prompt), `bypassPermissions`. Interactive default is now `auto` (v2.1.283+); `-p`/SDK default is `default`.

**Claude Code sandboxing** -- https://code.claude.com/docs/en/sandboxing ; runtime https://github.com/anthropic-experimental/sandbox-runtime
Seatbelt on macOS, bubblewrap+socat (+seccomp) on Linux, via `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0). Writes limited to cwd/tmp/`--add-dir`; reads mostly open unless `denyRead`; protected paths (`.claude/settings*`, `.mcp.json`, `.git/hooks`, shell rc) always write-denied. Network through a local proxy with `allowedDomains`/`deniedDomains`; `tlsTerminate` enables credential masking (`credentials.envVars[].mode: mask` injects the real value only to `injectHosts`). Sandboxed commands can auto-run without prompts; `allowUnsandboxedCommands:false` + `failIfUnavailable:true` for strict mode; `excludedCommands` is an escape hatch (full access). Caveat: MCP servers, hooks and built-in file tools run **outside** the sandbox. `srt` can also wrap an MCP server command.
Relevance: the OS mechanism to make "raw Bash with allowlist" defensible, and reusable from qharness for any agent (wrap the gateway's exec in `srt`).

**OpenCode permissions** -- https://opencode.ai/docs/permissions/
Rules `{action, resource, effect}` evaluated in order, last match wins; actions `shell` (was `bash`), `edit`, `read`, `skill`, `subagent`, `webfetch`, `external_directory`, MCP `<server>_<tool>`; shell scanner checks each subcommand and `cd` target and errors on unanalyzable commands; per-agent permission blocks; a separate policy layer (global/Console) hard-denies after rules.

**OpenCode MCP, custom tools, plugins** -- https://opencode.ai/docs/mcp-servers/ , https://docs.opencode.ai/docs/custom-tools/ , https://docs.opencode.ai/docs/plugins/
MCP: `mcp.servers.<name>` with `type: local|remote`, `{env:NAME}` substitution, OAuth by default for remote, `codemode: true` by default (groups tools under the server name), tools named `<server>_<tool>`, `disabled`, timeouts, `pool`. Custom tools: `.opencode/tools/*.ts` using `tool()` from `@opencode-ai/plugin` with Zod args and `execute(args, ctx)`. Plugins: hooks `tool.execute.before/after` (can modify args or block), `shell.env`, `event` (`permission.asked`, `permission.replied`, ...), plus custom tools; local `.opencode/plugins/` or npm.

**Claude Code hooks** -- https://code.claude.com/docs/en/hooks
Events incl. `PreToolUse` (decide `allow|deny|ask|defer`, `updatedInput`), `PermissionRequest`, `PermissionDenied`, `PostToolUse` (`updatedToolOutput`), `Elicitation`; matchers by tool name/regex plus `if: "Bash(git *)"`; hook types `command`, `http` (POST JSON to a URL, same response schema), `mcp_tool`, `prompt`, `agent`; `onFailure: block`.
Relevance: an `http` PreToolUse hook pointed at qharness gives the harness a veto/rewrite on every Bash call Claude Code makes, independent of ACP.

**Claude Code plugins** -- https://code.claude.com/docs/en/plugins
Directory with `.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, optional mods; load from disk with `--plugin-dir`; names/descriptions of skills cost context on every turn.

**Claude Code headless / Agent SDK** -- https://code.claude.com/docs/en/headless , https://code.claude.com/docs/en/agent-sdk/mcp , https://code.claude.com/docs/en/agent-sdk/permissions
`claude -p` with `--mcp-config`, `--strict-mcp-config`, `--allowedTools "Bash(git diff *),..."`, `--permission-mode`, `--permission-prompts none`, `--bare` (skips hooks/skills/plugins/.mcp.json; loads skills from `--add-dir`), `--output-format stream-json`. SDK: `mcpServers` in code (stdio/http/sse or in-process `createSdkMcpServer`), tools auto-named `mcp__<server>__<tool>`, `allowedTools: ["mcp__gw__*"]` recommended over permission modes, `canUseTool` callback is the last step after hooks > deny > ask > mode > allow. Custom tool `permission_policy: always_ask|always_deny`.

---

## 3. Trade-offs

### 3.1 Typed tool wrappers (MCP) vs raw shell with allowlists

**Mario Zechner, "MCP vs CLI" (2025-08-15)** -- https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/
120 runs, Claude Code, terminalcp MCP vs CLI vs tmux/screen: both 100% success; MCP ~23% faster and ~2.5% cheaper; "a wash"; tool design and docs matter more than protocol; suspects CLI costs come from Claude Code's per-Bash security checks. Advice: ship a good CLI first, layer MCP later.

**Kun Chen, GitHub CLI vs MCP vs Tool Search vs Code Mode** -- https://hn.jakechampion.name/reader/https://medium.com/@kunchenguid/i-benchmarked-github-cli-vs-mcp-vs-tool-search-vs-code-mode-turns-out-the-best-solution-is-none-93528d5039e4
GitHub MCP cost 2-3x the tokens of `gh`; tool search helps simple tasks (18K vs 42K context) but adds turns and cost on complex ones (0/5 on one task); code mode cheapest MCP variant but slowest and brittle on errors; author's "AXI" agent-oriented CLI (token-lean defaults, structured errors, next-step hints) won on cost and success. Caveat: self-authored baseline.

**mcp-vs-cli-bench (2026, UPC/USAL/UPV-EHU)** -- https://doi.org/10.5281/zenodo.21851991 (record page https://ekoizpen-zientifikoa.ehu.eus/documentos/6a776d7c5afd4024cfca2c42)
Open benchmark: 7 scaffoldings (Claude Code, Codex, qwen-code, Hermes, opencode, pi, Tau) x 5 models, same six-step GitHub workflow with official GitHub MCP vs shell only, verified via API, token proxy logging. Results not on the record page; worth downloading before committing to numbers.

**"CLI vs MCP: should your agent call tools or run commands?"** -- mcpservers.org -- https://blog.mcpservers.org/posts/cli-vs-mcp
CLI: lower token overhead, pipes/jq composability, training-data familiarity. MCP: reach into non-shell surfaces, scoped named operations that hosts can grant/deny/log, credentials stay behind the server boundary. Recommendation: CLI-first for trusted terminal agents, MCP where scoped permissions/audit are required; "token overhead is solvable" with deferred loading and code execution.

**"MCP Sucks (Until It Doesn't)"** -- Kaxil Naik -- https://kaxil.substack.com/p/mcp-vs-cli-vs-rest
Bloat came from auto-converted servers (GitHub: 93 tools, ~55K tokens), not the protocol; Claude Code/Cursor now defer schemas; ScaleKit's 75-run study (CLI 4-32x fewer tokens, 100% vs 72% success) predates tool search; conclusion "CLI + Skills" for developers, server-side MCP for scoped tokens/audit; "layers, not rivals"; "curate ruthlessly".

**"I built a Bitbucket CLI and it convinced me CLIs beat MCP"** -- Hugo Hebert -- https://dev.to/hugohbrt/i-built-a-bitbucket-cli-and-it-convinced-me-clis-beat-mcp-servers-for-ai-agents-3emm (repo https://github.com/Hugo-Hbrt/bbucket-cli)
`bb` CLI with `--json` and `--output-style ai` (tab-separated, no colour/box drawing); argues shell is "the universal tool protocol"; the one thing CLIs must fix for agents is default output.

**"6 developer CLIs that coding agents use well"** -- DeployHQ -- https://www.deployhq.com/blog/6-developer-clis-ai-coding-agents-use-well
gh, Linear, Vercel, dhq, flyctl, terraform. Traits: JSON output, verb-noun consistency, non-interactive defaults / skip-confirmation flags, actionable errors.

**Vercel CLI non-interactive behaviour** -- https://vercel.com/changelog/vercel-cli-for-marketplace-integrations-optimized-for-agents , https://vercel.com/docs/cli/agent
`--non-interactive` or auto-detected agent -> commands that cannot finish emit JSON with suggested follow-ups; `integration discover --format=json`; `vercel agent init --yes` required in non-interactive shells. A third-party note (https://ecorpit.com/vercel-cli-project-domains-json-confirmation-blocks-ci-2026/) claims some newer commands still block on prompts. No official Supabase "agent mode" docs were found.

Synthesis:
- Typed MCP wrapper: schema validation before the API, stable names for allow/deny/audit, credentials never in argv/history, works for agents without a shell, honest `readOnlyHint`/`destructiveHint` lets hosts auto-approve reads. Costs: schema tokens (mitigated by tool search / meta-tools), one round trip per call, server maintenance, risk of "auto-converting the whole API".
- Raw CLI through Bash + allowlist: zero wrapper maintenance, composable with `jq`, models already know `gh`/`kubectl`. Costs: prefix allowlists are bypassable (`/usr/bin/x`, `sh -c`, `npx`, env runners), every rule has to be written per agent (Claude `Bash(...)`, OpenCode `shell` rules), secrets live in the agent's env, interactive prompts hang, and in ACP v2 the harness no longer sees the command stream.
- Middle ground that most evidence supports: a *small* curated set of typed verbs for the risky/stateful operations + a guarded `run` tool for the long tail, with agent-oriented output (JSON or TSV, no ANSI), plus skills that teach the agent which verb to pick.

### 3.2 Auth / secret brokering
- Keep tokens in the gateway process, never in the agent's env: Docker MCP Gateway injects secrets per call and `--block-secrets` scrubs them from traffic; Lasso masks them in responses; Claude Code sandbox `credentials.mask` substitutes placeholders and injects real values only toward `injectHosts`; Arcade/Composio hold per-user OAuth tokens server-side.
- Short-lived creds: Claude Code's `headersHelper` and OpenCode's `{env:NAME}` show agents expect header/env injection at connect time; the gateway can mint per-session tokens (e.g. `gh auth token`, Jenkins API token, Supabase access token) and run CLIs with a scrubbed env.
- ACP: agents must not log `mcpServers[].env/headers`; still, prefer passing a *reference* (session ID) in the shim and resolving secrets inside the harness.

### 3.3 Sandboxing
- OS-level: `srt` (Seatbelt/bubblewrap) wraps any process including MCP servers; network allowlist by hostname; denies loopback/metadata IPs. Caveat: Claude Code's own sandbox excludes MCP servers, so the gateway must sandbox itself.
- Container-level: Docker MCP Gateway (cpu/mem caps, per-server containers, `--block-network`), Obot (Docker/K8s workloads + egress policy).
- Agent-level: Codex `INITIAL_AGENT_MODE` sandbox profiles; Claude `permissionMode` + sandbox; OpenCode `shell` rules. These do not protect the gateway's own exec path, so sandbox the gateway.

### 3.4 Rate limits, dry-run, idempotency
- ContextForge and MetaMCP implement per-endpoint/per-client rate limits; Composio sessions are per-user. For CLIs, the gateway should serialise or throttle per backend (Jenkins triggers, Vercel deploys) and cap output (Claude Code: 10k-token warning, 25k default max, 50k-char file spill; shell-mcp: 200 lines/8 KB per stream).
- MCP `idempotentHint`/`destructiveHint` let the gateway declare `vercel deploy`/`kubectl delete` as destructive and `kubectl get` as read-only; Claude Code plan/auto mode and OpenCode permission rules can key off names. Pair destructive verbs with `--dry-run`/`--plan` variants (kubectl `--dry-run=server`, terraform `plan`, `gh pr merge --dry-run` where available) and an idempotency token stored by the gateway for "run once" semantics.

### 3.5 Progressive disclosure
- Skills: ~100 tokens per skill at startup, body on demand (agentskills.io, Claude Code, OpenCode).
- MCP: Claude Code tool search (on by default; `alwaysLoad` exemptions; 4,096/16,384-char description limits), Anthropic Tool Search Tool (regex/BM25, 30-50 tool accuracy cliff), Lasso's `get_metadata`/`run_tool`, Composio's search meta-tools, OpenCode Code Mode grouping tools per server, Atlassian's discover/execute vs `?tools=all`.
- Code execution: Anthropic's filesystem-of-wrappers pattern (needs a sandbox), OpenCode `codemode`, Pi's Codemode.

---

## 4. How Claude Code and OpenCode integrate external tools (summary matrix)

| Concern | Claude Code | OpenCode |
|---|---|---|
| MCP config | `.mcp.json` (project), `~/.claude.json` (local/user), `--mcp-config` + `--strict-mcp-config`, plugin `.mcp.json`; tool name `mcp__<server>__<tool>` | `opencode.json` `mcp.servers.<name>` `{type: local|remote}`; `{env:X}`; tool name `<server>_<tool>`; `codemode` default on |
| Tool-context control | Tool search default on; `ENABLE_TOOL_SEARCH=auto:N`; `alwaysLoad`; `_meta anthropic/alwaysLoad`, `anthropic/maxResultSizeChars`, `anthropic/requiresUserInteraction` | Code Mode grouping; permission `deny` hides tools; server instructions dropped when all tools denied |
| Permissions | allow/ask/deny rules, `Bash(prefix *)`, `mcp__srv__*`; modes default/acceptEdits/plan/auto/dontAsk/bypass; deny wins | ordered `{action,resource,effect}` rules, last match wins; `shell`, `skill`, `<server>_<tool>`; per-agent rules; policy layer |
| Hooks | PreToolUse/PermissionRequest/PostToolUse etc.; `command`, `http`, `mcp_tool`, `prompt`, `agent` types; can rewrite input | plugin `tool.execute.before/after`, `shell.env`, events `permission.asked/replied` |
| Custom in-process tools | Agent SDK `createSdkMcpServer` + `tool()`; `permission_policy` | `.opencode/tools/*.ts` `tool()` with Zod; plugin-returned tools |
| Skills | `~/.claude/skills`, `.claude/skills`, nested, `--add-dir`, plugins; rich frontmatter | `.opencode/skills`, `.claude/skills`, `.agents/skills`, HTTP catalogs; `skill` permission |
| Sandbox | Seatbelt/bubblewrap via `sandbox-runtime`; network proxy allowlist; credential masking | none built in (relies on permission rules) |
| ACP | via `claude-agent-acp` (Agent SDK); client MCP servers supported; permission requests; API-key auth for third-party harnesses | native `opencode acp`; config MCP servers supported; client-provided `mcpServers` handling undocumented |
| Headless | `claude -p --bare --mcp-config ... --allowedTools "mcp__gw__*" --permission-mode dontAsk --output-format stream-json` | `opencode run` / server mode (not researched here) |

---

## Recommended architecture for qharness tool gateway

Options compared:

| Option | Pros | Cons |
|---|---|---|
| A. Pure allowlisted Bash (agent-native permission rules + skills) | zero gateway code; models know the CLIs; composable | per-agent rule dialects; prefix rules bypassable; secrets in agent env; interactive prompts; ACP v2 removes harness visibility of terminals |
| B. Vendor MCP servers passed through `mcpServers` (GitHub, Vercel, Supabase, Atlassian, Jenkins plugin, kubernetes-mcp-server) | typed, OAuth, maintained by vendors | 6 OAuth flows, 100+ tools of schema, different read-only semantics, no Jenkins/Bitbucket parity, no single audit point |
| C. Off-the-shelf MCP gateway (Docker MCP Gateway / Obot / ContextForge) in front of B | isolation, secret brokering, interceptors, audit | still API-shaped tools, Docker dependency, heavy for a local harness, cannot run `kubectl`/`supabase` CLIs that have no MCP |
| D. **qharness "toolgw" MCP server: curated typed verbs over the CLIs + guarded `run` + skills, injected via ACP `mcpServers`** | one implementation for every ACP agent; harness owns secrets, sandbox, policy, audit; honest annotations; progressive disclosure | you maintain the verb catalogue and CLI output parsing |

Recommendation: **D, with B used selectively behind it** (e.g. proxy Atlassian Rovo or GitHub remote MCP through the gateway where a CLI is weaker), and A kept as the documented fallback for local dev.

1. **Ship the gateway as a stdio MCP server listed in ACP `session/new.mcpServers`** (`name: "qharness"`, absolute `command`, per-session token in `env`). This is the only mechanism that survives ACP v1 -> v2 and works identically for `claude-agent-acp`, `opencode acp`, `codex-acp` and Gemini CLI. The stdio binary should be a thin shim that tunnels to the long-lived qharness process (ACP architecture page; mcp-proxy shows the pattern).
2. **Do not rely on ACP client terminals** for CLI interception (removed in v2, inconsistently implemented); use them only for display/UX in v1 clients.
3. **Expose few, curated verbs** per backend (`gh.pr_view`, `gh.pr_create`, `k8s.get`, `k8s.apply`, `supabase.db_push`, `vercel.deploy`, `jenkins.build_trigger`, `bb.pr_list`), each mapping to a vetted CLI invocation with fixed flags (`--json`, `--non-interactive`, `--yes`), parsed to compact JSON. Avoid auto-generating a tool per subcommand; every benchmark attributes MCP's cost to bloated catalogues.
4. **Add one guarded `run` tool** for the long tail, modelled on shell-mcp: argv array (no shell), hard denylist first, per-tool allowlist of `<binary> <subcommand>` patterns, cwd confined to session roots, env scrubbed, output clipped (default ~8 KB per stream, spill to file). This replaces agent-specific `Bash(...)` rules, which the Claude docs themselves call fragile.
5. **Annotate honestly**: set `readOnlyHint`, `destructiveHint`, `idempotentHint` on every verb; Claude Code's plan/auto modes and OpenCode rules consume names and read-only hints, so read verbs can be auto-approved while `*.delete`/`*.deploy` prompt. Mark high-impact verbs with `_meta["anthropic/requiresUserInteraction"]` where a human must confirm.
6. **Progressive disclosure in two layers**: (a) a `SKILL.md` per backend (`skills/gh/SKILL.md`, ...) that lists the verbs, flags and safety rules, loaded on demand by both Claude Code and OpenCode from a shared `.claude/skills` (or `--add-dir`) directory; (b) MCP server `instructions` that tell tool search when to look for `qharness_*` tools, with descriptions under 4,096 chars and consistent `gh_`, `k8s_` prefixes. Keep the 3-5 most-used verbs `alwaysLoad`.
7. **Broker secrets in the harness**: resolve `GH_TOKEN`, kubeconfig context, Supabase/Vercel tokens, Jenkins API token, Bitbucket credentials inside qharness per session, inject them only into the child CLI's env, strip them from results (regex masking like Lasso `basic` / Docker `--block-secrets`). The agent never sees a token; ACP `env` carries only a session handle.
8. **Sandbox the gateway's exec path**, not just the agent: wrap CLI execution with `@anthropic-ai/sandbox-runtime` (`srt`) using a per-backend network allowlist (`api.github.com`, `*.supabase.co`, `vercel.com`, your Jenkins host, cluster API) and write access limited to the session cwd/tmp. Claude Code's own sandbox does not cover MCP servers.
9. **Policy engine with dry-run and idempotency**: every destructive verb has a `dry_run` parameter (kubectl `--dry-run=server`, `supabase db push --dry-run`, `vercel build` before `deploy`), an optional `idempotency_key` recorded by the gateway, and a policy table (allow / ask-via-ACP `session/request_permission` / deny) per verb x environment (dev/staging/prod). Rate-limit and serialise per backend.
10. **Auto-answer ACP permission prompts from that same policy**: when the agent emits `session/request_permission` for a `qharness_*` tool, qharness selects `allow_once`/`reject_once` per policy, so the human only sees prompts for genuinely risky actions; log every `tool_call` update as the audit trail.
11. **Belt-and-braces inside each agent**: for Claude Code sessions, also pass `--mcp-config`/`allowedTools: ["mcp__qharness__*"]`, deny `Bash(gh *)`, `Bash(kubectl *)`, etc. so the model routes through the gateway, and register an `http` PreToolUse hook to qharness for any residual Bash; for OpenCode, ship `permission` rules (`shell` ask, `qharness_*` allow for read verbs) and optionally a plugin using `tool.execute.before`.
12. **Reuse vendor MCP where it is strictly better**: proxy Atlassian Rovo (`?tools=all` behind your own filter) or GitHub remote MCP through the gateway for operations the CLIs lack, re-namespaced under `qharness_` so the agent sees one catalogue and one auth model.
13. **Agent-oriented output contract**: default to compact JSON or TSV, no ANSI/box drawing, include `next_steps` hints and structured errors (`{code, message, retryable, suggestion}`), following the AXI/bb findings; cap output and spill to files with a path.
14. **Testing**: adopt the mcp-vs-cli-bench style (verify end state through the API, log tokens via a proxy) to measure your own verbs vs raw CLI on 5-6 representative workflows per backend before expanding the catalogue.
15. **Phasing**: v0 = `run` + allowlist + skills (fast, covers everything); v1 = typed verbs for gh/kubectl/jenkins (highest risk); v2 = secret masking + `srt` sandbox + policy prompts; v3 = vendor MCP proxying and tool search tuning.

---

## Appendix: additional sources consulted (search-level only)

- Tyk, MCP vs CLI for AI agents: https://tyk.io/learning-center/mcp-vs-cli-for-ai-agents-enterprise-comparison-guide/
- DeployHQ, CLIs or MCP for coding agents: https://www.deployhq.com/blog/clis-or-mcp-for-coding-agents-practical-comparison
- StackOne, MCP vs CLI: https://www.stackone.com/blog/mcp-vs-cli-for-ai-agents/
- Firecrawl, MCP vs CLI: https://firecrawl.dev/blog/mcp-vs-cli
- Composio vs Arcade (vendor): https://composio.dev/blog/composio-vs-arcade , https://arcade.dev/compare/arcade-vs-composio/
- ACP in Zed/VS Code community write-ups: https://dev.to/formulahendry/vs-code-acp-client-extension-conect-to-claude-gemini-codex-opencode-qwen-code-and-so-on-3552 , https://tessl.io/blog/zed-debuts-agent-client-protocol-to-connect-ai-coding-agents-to-any-editor/
- Running Claude Code via ACP after the OAuth change: https://cookbook.solomonneas.dev/ai-stack/acp-claude-code/
- Docker MCP Gateway interceptors (third-party): https://dasroot.net/posts/2026/01/docker-mcp-gateway-interceptors-security/
- Agent Skills GitHub: https://github.com/agentskills/agentskills
