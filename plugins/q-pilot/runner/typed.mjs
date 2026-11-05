// Typed fixtures: a fixture may be { value, type: "date", aliases: [...] } instead of a string. Code, not a model, turns
// the value into what a field takes: a date in the field's own format, and the aliases one after another when an
// autocomplete list shows nothing for the value. Jev still sees the key only. Pure, so it is easy to test.

export const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const MAX_ALIASES = 5

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s) {
  const m = ISO_DATE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

/**
 * The date pattern a field asks for, from its type, placeholder, pattern attribute or label: "iso" for a native date
 * input, a token pattern such as "DD/MM/YYYY", or null when the field does not say.
 */
export function datePattern({ type = '', placeholder = '', label = '' } = {}) {
  if (type === 'date') return 'iso'
  for (const hint of [placeholder, label]) {
    const m = /\b(dd|mm|yyyy|yy)([./ -])(dd|mm)\2(dd|mm|yyyy|yy)\b/i.exec(hint)
    if (m) return `${m[1]}${m[2]}${m[3]}${m[2]}${m[4]}`.toUpperCase()
  }
  return null
}

/** `iso` (YYYY-MM-DD) written in `pattern` (from datePattern); the value unchanged without a pattern. */
export function formatDate(iso, pattern) {
  const m = ISO_DATE.exec(iso)
  if (!m || !pattern) return iso
  if (pattern === 'iso') return iso
  const [, y, mo, d] = m
  return pattern.replace(/YYYY|YY|MM|DD/g, t => ({ YYYY: y, YY: y.slice(2), MM: mo, DD: d })[t])
}

/** The type and aliases of each typed fixture in `fixtures` (a flow's or spec's own), by key. */
export function formsOf(fixtures = {}) {
  const forms = {}
  for (const [k, v] of Object.entries(fixtures)) {
    if (v && typeof v === 'object') forms[k] = { ...(v.type && { type: v.type }), ...(v.aliases && { aliases: v.aliases }) }
  }
  return forms
}

/** Every way a typed fixture may show up in a field: the value, its date formats and its aliases. */
export function variantsOf(value, form) {
  const out = [value]
  if (form?.type === 'date' && ISO_DATE.test(value)) {
    const [, y, mo, d] = ISO_DATE.exec(value)
    const month = MONTHS[+mo - 1]
    out.push(`${d}/${mo}/${y}`, `${mo}/${d}/${y}`, `${d}.${mo}.${y}`, `${d}-${mo}-${y}`, `${month} ${+d}, ${y}`, `${+d} ${month} ${y}`, `${+d} ${month.slice(0, 3)} ${y}`)
  }
  for (const a of form?.aliases ?? []) out.push(a)
  return out
}
