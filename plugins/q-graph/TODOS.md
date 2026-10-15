# q-graph

When claude code spawn multiple subagent, agent team i want to visualize it or if it it can i want to have an workflow digram which containt subagent, skills, rule, used ....

- [x] 0.1: roster band, needs-you alert, `/q-graph` pane with the agent tree (Raster, box-drawing edges, moving dots)
- [ ] 0.2: team view (dagre), time slider, Mermaid export, HTML snapshot with React Flow, SVG + SMIL pane for desktop
- [x] Live browser viewer: `/q-graph web` (snapshot file → viewer process → SSE → React Flow)
- [ ] 0.3: decision (ADR) nodes
- [ ] 0.4: ADR drafts by Haiku, ADRs through `prompt.compose`, cost per agent type, pixel images (kitty, Ghostty)
- [x] Uses per agent: tools, skills (`Skill` calls), MCP servers and rules (`classic.InstructionsLoaded`) under each agent's own card, in the pane and the viewer
- [x] Harness card: settings hooks, memory files, skills, MCP servers, custom agents (`$.settings.read`, `$.session.usage` breakdown)
- [ ] Hooks per agent: no event says which agent a hook fired for, and plugin hooks modules cannot be listed
- [x] Review fixes (0.1.x): viewer start race, `lost` agents, in-flight calls per agent, stub nodes, NaN tokens, snapshot retry; viewer Host check, CSP and security headers, SRI, size-bounded slim timeline index, temp-folder sweep; pane width fitting, message-arc columns, faster frames; readable first view, task subtitles, mobile sheet
- [ ] Stuck heuristic: a tool running far past its median, no event for minutes, or the same call repeated
- [ ] Live tokens and cost per agent in the viewer, from transcript usage (cache reads included)
- [ ] Format canary: count unknown transcript records and unmatched lanes, show a "format drift?" badge
- [ ] Replay and static export from `/timeline`; files changed per agent
