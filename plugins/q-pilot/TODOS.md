# q-pilot TODOS

What 0.1 leaves out.

- **Haiku fallback.** Without Jev, a missed step ends as `blocked` and an untraced flow as `untraced`. A guarded Haiku pick for those cases was in the design report and is not built.
- **YAML flows.** Flows are JSON. A YAML reader (and a converter) could come later.
- **Scope disambiguation beyond landmarks.** Look-alike elements are told apart only by the name of the nearest form, dialog, landmark or list. Anything finer (row text, position) is a miss today.
- **Iframes and shadow DOM.** The snapshot does not see shadow roots, iframes, canvas, file uploads or popup tabs.
- **CI export by default.** `/q-pilot export` writes a Playwright spec on request. Exporting every flow on accept, and a CI recipe for running them, is not set up.
- **A viewer.** Runs are JSON and screenshots in `.q-pilot/runs/`. There is no page that shows them.
- **Jev latency in a loop.** The design PoC timed single calls. A p95 over many calls (for the 3000 ms request timeout) has not been measured.
