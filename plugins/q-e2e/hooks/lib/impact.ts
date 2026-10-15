// Impact map: which Playwright specs a set of changed files should run. Pure, so it is easy to test.
// All paths are repo-relative with forward slashes; callers turn absolute tool paths into that form first.

import type { ImpactConfig, ImpactSelection } from './contract'

export const DEFAULT_TEST_DIR = 'tests'
export const DEFAULT_SMOKE_TAG = '@smoke'

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

/** Never UI-relevant: tooling output, docs, lockfiles and config files. */
export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '{dist,build,out,coverage,.next,.nuxt,.svelte-kit,playwright-report,test-results,blob-report}/**',
  'playwright/.auth/**',
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

const isUnder = (path: string, dir: string) => {
  const d = normalizePath(dir)
  return d === '' || d === '.' || path === d || path.startsWith(`${d}/`)
}

/** Whether an edit to this file can change what an E2E spec sees (app code, styles, templates, or the specs themselves). */
export function isUiRelevant(path: string, cfg: ImpactConfig): boolean {
  const p = normalizePath(path)
  if (!p || matchesAny(p, cfg.ignore) || matchesAny(p, DEFAULT_IGNORE)) return false
  if (isUnder(p, cfg.testDir ?? DEFAULT_TEST_DIR)) return UI_EXT.test(p)
  if (UNIT_TEST.test(p)) return false // unit tests next to app code do not change the app
  return UI_EXT.test(p) || LOCALE_JSON.test(p)
}

const ROUTE_ROOT = /(?:^|\/)(app|pages|routes)\/(.*)$/
const ROUTE_FILE_PAGE = /^(?:\+page|page|index)$/
const NOT_ROUTE = /^(?:components?|lib|utils?|hooks|ui|styles|helpers|assets|server|actions)$/
const ROUTE_FILE = /^(?:\+.*|page|layout|template|loading|error|not-found|default|route|index|_layout)$/

/**
 * Infers the URL route a file belongs to, or undefined when it is not under a router folder.
 * `app/(shop)/checkout/page.tsx`, `pages/checkout.tsx`, `pages/checkout/index.tsx` and
 * `src/routes/checkout/+page.svelte` all give `/checkout`. Stops at the first dynamic segment.
 */
export function routeOf(path: string): string | undefined {
  const m = ROUTE_ROOT.exec(normalizePath(path))
  if (!m) return undefined
  const kind = m[1]
  const segs = m[2]!.split('/')
  const file = segs.pop()!.replace(/\.[^.]+$/, '').replace(/\.(?:server|client)$/, '')
  // In app/ and routes/ folders, only special files are pages; a colocated component belongs to its folder's route.
  if (kind === 'pages' && !ROUTE_FILE.test(file) && !file.startsWith('_')) segs.push(file)
  if (kind === 'pages' && file.startsWith('_')) return undefined // _app, _document: all routes, handled by smoke
  if (segs[0] === 'api') return undefined
  const route: string[] = []
  for (const s of segs) {
    if (NOT_ROUTE.test(s)) break // colocated code folder: the file belongs to the route above it
    if (!s || /^\(.*\)$/.test(s) || s.startsWith('@') || s.startsWith('_')) continue
    if (s.startsWith('[') || s.startsWith(':') || s.startsWith('$')) break
    route.push(s)
  }
  // A root-level non-page file (app/layout.tsx, app/globals.css) affects every page: leave it to smoke.
  if (route.length === 0 && !ROUTE_FILE_PAGE.test(file)) return undefined
  return `/${route.join('/')}`
}

const GOTO = /\bgoto\(\s*[`'"](?:https?:\/\/[^/`'"]*)?(\/[^`'"]*)?[`'"]/g

/** The paths a spec visits through `page.goto(...)`. */
export function gotoPaths(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(GOTO)) out.push(m[1] ?? '/')
  return out
}

const routeMatches = (route: string, visited: string) => {
  if (route === '/') return visited === '/' || /^\/[?#]/.test(visited)
  return visited === route || (visited.startsWith(route) && /^[/?#]/.test(visited.slice(route.length)))
}

const isSpecFile = (p: string) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(p)

/** Picks the specs to run for this turn's changed files: config map, then routes, then changed specs; else smoke or none. */
export function selectSpecs(
  changed: string[],
  allSpecs: string[],
  specSources: Record<string, string>,
  cfg: ImpactConfig,
): ImpactSelection {
  const relevant = [...new Set(changed.map(normalizePath))].filter(p => isUiRelevant(p, cfg))
  if (relevant.length === 0) return { mode: 'none', specs: [], why: ['no UI-relevant change'] }

  const specs = allSpecs.map(normalizePath)
  const sources: Record<string, string> = {}
  for (const [k, v] of Object.entries(specSources)) sources[normalizePath(k)] = v

  const picked = new Set<string>()
  const why: string[] = []
  const pick = (file: string, spec: string, how: string) => {
    if (!picked.has(spec)) why.push(`${file} → ${spec} (${how})`)
    picked.add(spec)
  }
  const matched = new Set<string>()

  // Pass 1: the explicit map in q-e2e.config.json.
  for (const file of relevant) {
    for (const [src, targets] of Object.entries(cfg.map ?? {})) {
      if (!matchesGlob(file, src)) continue
      for (const t of targets) {
        for (const spec of specs) {
          if (matchesGlob(spec, t)) {
            pick(file, spec, 'map')
            matched.add(file)
          }
        }
      }
    }
  }

  // Pass 2: route inference from the router folder to specs that goto() that route.
  for (const file of relevant) {
    if (matched.has(file) || isUnder(file, cfg.testDir ?? DEFAULT_TEST_DIR)) continue
    const route = routeOf(file)
    if (!route) continue
    for (const spec of specs) {
      if (gotoPaths(sources[spec] ?? '').some(v => routeMatches(route, v))) {
        pick(file, spec, `route ${route}`)
        matched.add(file)
      }
    }
  }

  // Pass 3: a changed spec runs itself.
  for (const file of relevant) {
    if (specs.includes(file) || (isSpecFile(file) && isUnder(file, cfg.testDir ?? DEFAULT_TEST_DIR))) {
      if (!picked.has(file)) why.push(`${file} (changed spec)`)
      picked.add(file)
      matched.add(file)
    }
  }

  if (picked.size > 0) {
    const unmatched = relevant.filter(f => !matched.has(f))
    if (unmatched.length) {
      // Changed files no spec covers: the smoke specs stand in for them.
      const tag = cfg.smokeTag ?? DEFAULT_SMOKE_TAG
      for (const spec of specs) if (sources[spec]?.includes(tag)) pick(unmatched[0]!, spec, `smoke ${tag}`)
      why.push(`no spec mapped: ${unmatched.join(', ')}`)
    }
    return { mode: 'specs', specs: [...picked].sort(), why }
  }
  const tag = cfg.smokeTag ?? DEFAULT_SMOKE_TAG
  return { mode: 'smoke', specs: [], why: [`${relevant.length} UI file(s) changed, no spec mapped → ${tag}`] }
}
