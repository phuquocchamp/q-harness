// Impact map: which flows a set of changed files should run. Pure, so it is easy to test.
// All paths are repo-relative with forward slashes; callers turn absolute tool paths into that form first.

import type { FlowDef, FlowSelection, PilotConfig } from './contract'

export const DEFAULT_FLOWS_DIR = 'flows'
export const SMOKE_TAG = 'smoke'

/** Turns `./a\b/c` into `a/b/c`. */
export const normalizePath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '')

const REGEX_SPECIAL = /[.+^$()|[\]\\}]/

/** Converts a glob (`**`, `*`, `?`, `{a,b}`) into an anchored RegExp over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globBody(normalizePath(glob))}$`)
}

function globBody(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/'
        if (atStart && glob[i + 2] === '/') {
          out += '(?:.*/)?' // `**/` matches zero or more directories
          i += 2
        } else if (atStart && i + 2 === glob.length && i > 0) {
          out = out.slice(0, -1) + '(?:/.*)?' // trailing `/**` also matches the folder itself
          i += 1
        } else {
          out += '.*'
          i += 1
        }
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') {
      const end = closingBrace(glob, i)
      if (end < 0) out += '\\{'
      else {
        out += `(?:${splitAlternatives(glob.slice(i + 1, end)).map(globBody).join('|')})`
        i = end
      }
    } else if (REGEX_SPECIAL.test(c)) out += `\\${c}`
    else out += c
  }
  return out
}

function closingBrace(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i
  }
  return -1
}

function splitAlternatives(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') depth--
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

export const matchesGlob = (path: string, glob: string): boolean => globToRegExp(glob).test(normalizePath(path))

const matchesAny = (path: string, globs: readonly string[] | undefined) => (globs ?? []).some(g => matchesGlob(path, g))

/** Never UI-relevant: tooling output, docs, lockfiles, config files and q-pilot's own files. */
export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '.q-pilot/**',
  '{dist,build,out,coverage,.next,.nuxt,.svelte-kit,playwright-report,test-results,blob-report}/**',
  '**/*.{md,mdx,txt,lock,log,map}',
  '**/{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lockb}',
  '**/*.config.{js,cjs,mjs,ts,cts,mts}',
  '**/{.eslintrc,.prettierrc,tsconfig,jsconfig}*',
  '.github/**',
  '.claude/**',
  '**/.env*',
]

const UI_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|css|scss|sass|less|styl|hbs|ejs|njk|liquid|erb|php|py|rb|go|rs|java|kt|cs|graphql|gql|prisma|sql)$/i
const LOCALE_JSON = /(?:^|\/)(?:locales?|i18n|lang|messages|translations)\/.*\.json$/i
const UNIT_TEST = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

/** Whether an edit to this file can change what a flow sees (app code, styles, templates, locale files). */
export function isUiRelevant(path: string, cfg: PilotConfig): boolean {
  const p = normalizePath(path)
  if (!p || matchesAny(p, cfg.ignore) || matchesAny(p, DEFAULT_IGNORE)) return false
  const flowsDir = normalizePath(cfg.flowsDir ?? DEFAULT_FLOWS_DIR)
  if (p === flowsDir || p.startsWith(`${flowsDir}/`)) return false
  if (UNIT_TEST.test(p)) return false
  return UI_EXT.test(p) || LOCALE_JSON.test(p)
}

/**
 * Picks the flows to run for this turn's changed files. A file selects the flows whose `covers`
 * glob matches it. A UI file that selects nothing selects the `smoke` flows, and so do changed files
 * left over when others did select flows. `all` runs every flow.
 */
export function selectFlows(changed: string[], flows: FlowDef[], cfg: PilotConfig, mode: 'affected' | 'all' = 'affected'): FlowSelection {
  const relevant = [...new Set(changed.map(normalizePath))].filter(p => isUiRelevant(p, cfg))
  if (relevant.length === 0) return { mode: 'none', ids: [], why: ['no UI-relevant change'] }
  if (mode === 'all') return { mode: 'all', ids: flows.map(f => f.id).sort(), why: ['mode all'] }

  const picked = new Set<string>()
  const matched = new Set<string>()
  const why: string[] = []
  for (const file of relevant) {
    for (const flow of flows) {
      if (!(flow.covers ?? []).some(g => matchesGlob(file, g))) continue
      if (!picked.has(flow.id)) why.push(`${file} → ${flow.id} (covers)`)
      picked.add(flow.id)
      matched.add(file)
    }
  }
  const unmatched = relevant.filter(f => !matched.has(f))
  if (unmatched.length > 0) {
    const smoke = flows.filter(f => (f.tags ?? []).includes(SMOKE_TAG))
    for (const flow of smoke) {
      if (!picked.has(flow.id)) why.push(`${unmatched[0]} → ${flow.id} (${SMOKE_TAG})`)
      picked.add(flow.id)
    }
    why.push(`no flow covers: ${unmatched.join(', ')}`)
  }
  if (picked.size === 0) return { mode: 'none', ids: [], why }
  return { mode: 'flows', ids: [...picked].sort(), why }
}
