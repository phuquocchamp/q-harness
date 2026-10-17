// Pure helpers for the q-pilot Dashboard: the ready mark its process prints (runner/dash-server.mjs) and the
// link the band adds to a red run. No `$` here; the process itself is started in register.tsx.

/** The dashboard's stderr line once it listens: `[q-pilot] dash {"url","file","reused"}`. */
export const DASH_MARK = '[q-pilot] dash '

export type DashMark = { url: string; file: string; reused: boolean }

/** The mark's content, or undefined when the line is not a well-formed dash mark (only a loopback URL counts). */
export function parseDashMark(line: string): DashMark | undefined {
  if (!line.startsWith(DASH_MARK)) return undefined
  try {
    const m = JSON.parse(line.slice(DASH_MARK.length)) as { url?: unknown; file?: unknown; reused?: unknown }
    if (typeof m.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/\S*$/.test(m.url)) return undefined
    if (typeof m.file !== 'string' || !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(m.file)) return undefined
    return { url: m.url, file: m.file, reused: m.reused === true }
  } catch {
    return undefined
  }
}

/** The dashboard's link to one session (`<runId>:<flowId>`), the form `#s=` the page selects on load. */
export const sessionLink = (url: string, runId: string, flowId: string) => `${url.replace(/#.*$/, '')}#s=${encodeURIComponent(runId)}:${encodeURIComponent(flowId)}`

/** The band's link to the first red flow, when a dashboard is up. */
export const bandLink = (dashUrl: string | undefined, runId: string, firstRedFlow: string | undefined) => (dashUrl && firstRedFlow ? sessionLink(dashUrl, runId, firstRedFlow) : undefined)
