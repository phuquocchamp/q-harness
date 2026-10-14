// Splits an assistant reply into markdown prose and fenced code blocks. Pure, so it is easy to test.

export type Segment =
  | { kind: 'md'; text: string }
  /** `closed` is false while a reply is still streaming the block. */
  | { kind: 'code'; lang: string; code: string; closed: boolean }

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/

/**
 * Cuts `text` at CommonMark fences (``` or ~~~, three or more, up to three spaces of indent).
 * A fence closes on the same character, at least as long, with nothing after it.
 */
export const splitFences = (text: string): Segment[] => {
  const out: Segment[] = []
  const prose: string[] = []
  const flush = () => {
    const t = prose.join('\n')
    if (t.trim()) out.push({ kind: 'md', text: t })
    prose.length = 0
  }

  const rows = text.split('\n')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? ''
    const m = OPEN.exec(row)
    if (!m) {
      prose.push(row)
      continue
    }
    const fence = m[1] ?? '```'
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`)
    const body: string[] = []
    let j = i + 1
    while (j < rows.length && !close.test(rows[j] ?? '')) body.push(rows[j++] ?? '')
    flush()
    out.push({ kind: 'code', lang: (m[2] ?? '').toLowerCase(), code: body.join('\n'), closed: j < rows.length })
    i = j
  }
  flush()
  return out
}

export const hasFence = (text: string) => text.split('\n').some(r => OPEN.test(r))
