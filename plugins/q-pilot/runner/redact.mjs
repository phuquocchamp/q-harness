// Secret redaction, ported from q-e2e hooks/lib/jev.ts. Fixture values are passed in as extra secrets.
export const REDACTED = '[redacted]'
const MIN_SECRET = 4

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Bounded affixes keep long word runs from backtracking quadratically.
const SECRET_KEY = '[\\w.-]{0,40}(?:password|passwd|pwd|passcode|token|secret|api[_-]?key|apikey|access[_-]?key|session[_-]?id|totp|credential)[\\w.-]{0,40}'

const RULES = [
  [/^([+\-\s>*]*(?:set-cookie|cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token)\s*:\s*).+$/gim, `$1${REDACTED}`],
  [/((["']?)(?:set-cookie|cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token)\2\s*[:=]\s*)(["'`])(?:(?!\3)[^\\]|\\.)*\3/gi, `$1$3${REDACTED}$3`],
  [/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9\-._~+/]*\d)[A-Za-z0-9\-._~+/]{8,}=*/gi, `$1 ${REDACTED}`],
  [new RegExp(`((["']?)${SECRET_KEY}\\2\\s*:\\s*)(["'\`])(?:(?!\\3)[^\\\\]|\\\\.)*\\3`, 'gi'), `$1$3${REDACTED}$3`],
  [new RegExp(`\\b(${SECRET_KEY})=([^&\\s"'\`#;,)]+)`, 'gi'), `$1=${REDACTED}`],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
]

/** Replaces the exact `secrets` (4+ chars) plus cookie, Authorization/Bearer, password/token values and JWTs with "[redacted]". */
export function redact(text, secrets = []) {
  let out = String(text)
  const list = [...new Set(secrets.filter(s => typeof s === 'string' && s.length >= MIN_SECRET))].sort((a, b) => b.length - a.length)
  for (const s of list) out = out.replace(new RegExp(escapeRegExp(s), 'g'), REDACTED)
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}

/** Like redact, but a value that equals a secret of any length (a filled field) is replaced whole. */
export function redactValue(text, secrets = []) {
  return secrets.includes(text) && text !== '' ? REDACTED : redact(text, secrets)
}

/** Redacts every string in a JSON-like value. */
export function redactDeep(value, secrets) {
  if (typeof value === 'string') return redactValue(value, secrets)
  if (Array.isArray(value)) return value.map(v => redactDeep(v, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]))
  return value
}
