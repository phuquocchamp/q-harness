// Run with: node --test viewer/transcript.test.mjs
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { OUTPUT_CAP, TranscriptIndex, buildTimeline, cap, hintOf, useKeyOf } from './transcript.mjs'

const root = mkdtempSync(join(tmpdir(), 'q-graph-transcript-'))
after(() => rmSync(root, { recursive: true, force: true }))

let n = 0
const at = s => `2026-10-14T10:00:${String(s).padStart(2, '0')}.000Z`
const line = r => `${JSON.stringify(r)}\n`
const prompt = (text, s = 0, extra = {}) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content: text }, ...extra })
const use = (id, name, input, s, extra = {}) => ({
  type: 'assistant',
  timestamp: at(s),
  message: { id: `msg_${id}`, model: 'claude-x', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } },
  ...extra,
})
const result = (id, content, s, extra = {}) => ({
  type: 'user',
  timestamp: at(s),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(extra.isError ? { is_error: true } : {}) }] },
  ...(extra.tur ? { toolUseResult: extra.tur } : {}),
})
const say = (text, s, msgId = `say_${s}`) => ({
  type: 'assistant',
  timestamp: at(s),
  message: { id: msgId, model: 'claude-x', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } },
})

const write = records => {
  const file = join(root, `t${n++}.jsonl`)
  writeFileSync(file, records.map(line).join(''))
  return file
}
const load = (file, opts) => {
  const ix = new TranscriptIndex(file, opts)
  assert.equal(ix.update(), true)
  return ix
}

test('useKeyOf mirrors graph.ts useKey', () => {
  assert.equal(useKeyOf('Agent', {}), null)
  assert.equal(useKeyOf('Task', {}), null)
  assert.equal(useKeyOf('Skill', { skill: 'commit' }), 'skill:commit')
  assert.equal(useKeyOf('Skill', {}), 'Skill')
  assert.equal(useKeyOf('mcp__context7__query-docs', {}), 'mcp:context7')
  assert.equal(useKeyOf('Bash', undefined), 'Bash')
})

test('pairs tool_use and tool_result by id, newest first, with timing and usage', () => {
  const file = write([
    prompt('do it', 0),
    use('a', 'Bash', { command: 'ls' }, 1),
    use('b', 'Read', { file_path: '/x' }, 2),
    result('b', [{ type: 'text', text: 'B out' }], 3),
    result('a', 'A out', 5, { tur: { stdout: 'A out', stderr: '' } }),
    say('done', 6),
  ])
  const d = load(file).detail({ id: 'main' })
  assert.deepEqual(d.calls.map(c => c.id), ['b', 'a'])
  const a = d.calls[1]
  assert.equal(a.output, 'A out')
  assert.equal(a.durationMs, 4000)
  assert.equal(a.endedAt, at(5))
  assert.equal(a.isError, false)
  assert.equal(d.calls[0].output, 'B out')
  assert.equal(d.agent.toolCalls, 2)
  assert.equal(d.agent.result, 'done')
  assert.equal(d.agent.model, 'claude-x')
  assert.equal(d.agent.prompt, 'do it')
  assert.equal(d.agent.startedAt, at(0))
  assert.equal(d.agent.endedAt, at(6))
  assert.deepEqual(d.agent.usage, { input: 21, output: 11, cacheCreate: 2, cacheRead: 4 })
})

test('usage counts a message split over several records once', () => {
  const file = write([say('one', 1, 'same'), say('two', 2, 'same')])
  assert.equal(load(file).detail().agent.usage.input, 1)
})

test('a running call has no output yet; is_error is reported', () => {
  const file = write([use('a', 'Bash', { command: 'false' }, 1), result('a', 'boom', 2, { isError: true }), use('b', 'Bash', { command: 'sleep 9' }, 3)])
  const [b, a] = load(file).detail().calls
  assert.equal(b.output, null)
  assert.equal(b.endedAt, null)
  assert.equal(b.durationMs, null)
  assert.equal(a.isError, true)
})

test('the use filter keeps only matching calls but toolCalls counts all', () => {
  const file = write([
    use('a', 'Bash', {}, 1),
    use('s', 'Skill', { skill: 'x' }, 2),
    use('m', 'mcp__server__tool', {}, 3),
    use('g', 'Agent', { prompt: 'go' }, 4),
    result('g', 'child done', 5, { tur: { agentId: 'abc123' } }),
  ])
  const ix = load(file)
  assert.deepEqual(ix.detail({ use: 'Bash' }).calls.map(c => c.id), ['a'])
  assert.deepEqual(ix.detail({ use: 'skill:x' }).calls.map(c => c.id), ['s'])
  assert.deepEqual(ix.detail({ use: 'mcp:server' }).calls.map(c => c.id), ['m'])
  const all = ix.detail()
  assert.equal(all.agent.toolCalls, 4)
  assert.equal(all.calls[0].agentId, 'abc123')
  assert.equal(all.calls[0].useKey, null)
})

test('long strings are truncated and images replaced', () => {
  const file = write([
    use('a', 'Write', { content: 'x'.repeat(5000), nested: { list: ['y'.repeat(4001)] } }, 1),
    result('a', [{ type: 'text', text: 'z'.repeat(9000) }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }], 2),
  ])
  const [c] = load(file).detail().calls
  assert.equal(c.input.content, `${'x'.repeat(4000)}…(truncated, 5000 chars)`)
  assert.match(c.input.nested.list[0], /…\(truncated, 4001 chars\)$/)
  assert.ok(c.output.endsWith('…(truncated, 9008 chars)'))
  assert.ok(!c.output.includes('AAAA'))
  assert.equal(cap('short', 10), 'short')
})

test('follows persistedOutputPath only inside the root', () => {
  const dir = join(root, 'proj')
  mkdirSync(join(dir, 'sess', 'tool-results'), { recursive: true })
  const inside = join(dir, 'sess', 'tool-results', 'big.txt')
  writeFileSync(inside, 'FULL OUTPUT')
  const outside = join(root, 'secret.txt')
  writeFileSync(outside, 'SECRET')
  const file = join(dir, 'sess.jsonl')
  writeFileSync(
    file,
    [
      use('a', 'Bash', {}, 1),
      result('a', '<persisted-output>preview</persisted-output>', 2, { tur: { persistedOutputPath: inside } }),
      use('b', 'Bash', {}, 3),
      result('b', '<persisted-output>p2</persisted-output>', 4, { tur: { persistedOutputPath: outside } }),
    ]
      .map(line)
      .join(''),
  )
  const [b, a] = load(file, { root: dir }).detail().calls
  assert.equal(a.output, 'FULL OUTPUT')
  assert.equal(b.output, '<persisted-output>p2</persisted-output>')
})

test('incremental: reads only appended lines and waits for a partial line', () => {
  const file = write([prompt('first', 0), use('a', 'Bash', {}, 1)])
  const ix = load(file)
  assert.equal(ix.detail().calls[0].output, null)
  const before = ix.offset
  const tail = line(result('a', 'done', 2))
  appendFileSync(file, tail.slice(0, 20))
  ix.update()
  assert.equal(ix.offset, before)
  assert.equal(ix.detail().calls[0].output, null)
  appendFileSync(file, tail.slice(20) + line(use('b', 'Read', {}, 3)))
  ix.update()
  const d = ix.detail()
  assert.deepEqual(d.calls.map(c => c.id), ['b', 'a'])
  assert.equal(d.calls[1].output, 'done')
  assert.equal(d.agent.toolCalls, 2)
})

test('a shrunk file is reparsed from the start', () => {
  const file = write([use('a', 'Bash', {}, 1), use('b', 'Bash', {}, 2)])
  const ix = load(file)
  writeFileSync(file, line(use('c', 'Bash', {}, 3)))
  ix.update()
  assert.deepEqual(ix.detail().calls.map(c => c.id), ['c'])
})

test('main prompt is the latest real one; subagent prompt is the first', () => {
  const file = write([
    prompt('task for you', 0, { parentUuid: null }),
    prompt('second real', 1),
    prompt('<command-name>/x</command-name>', 2),
    prompt('<task-notification>x</task-notification>', 3),
    prompt('injected skill text', 4, { isMeta: true }),
    { type: 'user', timestamp: at(5), message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>r</system-reminder>' }] } },
    use('a', 'Bash', {}, 6),
    result('a', 'out', 7),
  ])
  const ix = load(file)
  assert.equal(ix.detail({ id: 'main' }).agent.prompt, 'second real')
  assert.equal(ix.detail({ id: 'abc' }).agent.prompt, 'task for you')
})

test('a subagent result is its handed-back report, not its last text', () => {
  const file = write([
    prompt('task', 0, { parentUuid: null }),
    say('Now the register.tsx excerpt.', 1),
    use('h', 'SubagentHandback', { message: '## Final report' }, 2),
    say('Done.', 3),
  ])
  assert.equal(load(file).detail({ id: 'abc' }).agent.result, '## Final report')
  const plain = write([prompt('task', 0), say('the answer', 1)])
  assert.equal(load(plain).detail({ id: 'abc' }).agent.result, 'the answer')
})

test('bad lines and unknown types are skipped', () => {
  const file = join(root, 'bad.jsonl')
  writeFileSync(file, `not json\n${line({ type: 'queue-operation', x: 1 })}\n{"type":"assistant"\n${line(use('a', 'Bash', {}, 1))}null\n`)
  const d = load(file).detail()
  assert.equal(d.calls.length, 1)
})

test('a missing file reports false', () => {
  assert.equal(new TranscriptIndex(join(root, 'nope.jsonl')).update(), false)
})

test('hintOf picks one line per tool', () => {
  assert.equal(hintOf('Bash', { command: 'ls -la\n  && pwd' }), 'ls -la && pwd')
  assert.equal(hintOf('Read', { file_path: '/a/b/c.ts' }), 'c.ts')
  assert.equal(hintOf('Edit', { file_path: '/a/x.md' }), 'x.md')
  assert.equal(hintOf('Write', { file_path: 'y.txt' }), 'y.txt')
  assert.equal(hintOf('NotebookEdit', { notebook_path: '/n/z.ipynb' }), 'z.ipynb')
  assert.equal(hintOf('Grep', { pattern: 'foo.*' }), 'foo.*')
  assert.equal(hintOf('Glob', { pattern: '**/*.ts' }), '**/*.ts')
  assert.equal(hintOf('Skill', { skill: 'commit' }), 'commit')
  assert.equal(hintOf('Agent', { description: 'Build it' }), 'Build it')
  assert.equal(hintOf('Task', { description: 'Old name' }), 'Old name')
  assert.equal(hintOf('WebFetch', { url: 'https://x.dev' }), 'https://x.dev')
  assert.equal(hintOf('WebSearch', { query: 'q' }), 'q')
  assert.equal(hintOf('mcp__context7__query-docs', {}), 'query-docs')
  assert.equal(hintOf('TodoWrite', { todos: [] }), '')
  assert.equal(hintOf('Bash', undefined), '')
  const long = hintOf('Bash', { command: 'x'.repeat(500) })
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('…'))
})

const ix = records => load(write(records))
const sub = (id, records, meta = null) => ({ id, index: ix(records), meta })

test('timeline: parents via toolUseId or agentId, depth-first order, kinds and labels', () => {
  const main = ix([
    prompt('go', 0),
    use('spawnA', 'Agent', { description: 'Do A' }, 1),
    use('spawnB', 'Agent', { description: 'Do B' }, 5),
    result('spawnB', 'ok', 9, { tur: { agentId: 'B' } }),
  ])
  const A = sub('A', [prompt('a', 2), use('spawnA1', 'Task', { description: 'Do A1' }, 3), result('spawnA1', 'ok', 4, { tur: { agentId: 'A1' } })], {
    agentType: 'general-purpose',
    description: 'Do A',
    toolUseId: 'spawnA',
  })
  const A1 = sub('A1', [prompt('a1', 3), use('r', 'Read', { file_path: '/p/q.ts' }, 4)], { agentType: 'Explore' })
  const B = sub('B', [prompt('b', 6), say('done', 8)], { name: 'bee', teamName: 'hive', model: 'claude-y', toolUseId: 'missing' })
  const C = sub('C', [prompt('c', 7)], null)
  const t = buildTimeline({ main, subagents: [C, B, A1, A], now: at(30) })
  assert.equal(t.now, at(30))
  assert.equal(t.startedAt, at(0))
  assert.equal(t.endedAt, at(9))
  assert.deepEqual(
    t.lanes.map(l => [l.id, l.parentId, l.depth, l.spawnCallId, l.kind, l.label]),
    [
      ['main', null, 0, null, 'main', 'main'],
      ['A', 'main', 1, 'spawnA', 'subagent', 'general-purpose'],
      ['A1', 'A', 2, 'spawnA1', 'subagent', 'Explore'],
      ['B', 'main', 1, 'spawnB', 'teammate', 'bee@hive'],
      ['C', 'main', 1, null, 'subagent', 'subagent'],
    ],
  )
  const [m, a, a1, b] = t.lanes
  assert.equal(a.description, 'Do A')
  assert.equal(b.model, 'claude-y')
  assert.equal(a1.model, 'claude-x')
  assert.equal(m.calls[1].agentId, 'B')
  assert.equal(m.calls[1].useKey, null)
  assert.equal(m.calls[0].hint, 'Do A')
  assert.equal(a1.calls[0].hint, 'q.ts')
  assert.equal(a1.calls[0].useKey, 'Read')
  assert.equal(a1.calls[0].endedAt, null)
  assert.equal(a.startedAt, at(2))
  assert.equal(a.endedAt, at(4))
  assert.deepEqual(a.prompts, [])
  const named = buildTimeline({ main, subagents: [sub('T', [], { name: 'solo', agentType: 'general-purpose' })] }).lanes[1]
  assert.deepEqual([named.kind, named.label], ['subagent', 'solo'])
  const mate = buildTimeline({ main, subagents: [sub('M', [], { name: 'rev', taskKind: 'in_process_teammate' })] }).lanes[1]
  assert.deepEqual([mate.kind, mate.label], ['teammate', 'rev'])
})

test('timeline: main prompts keep only real ones, single line and capped', () => {
  const main = ix([
    prompt('first\nline', 0, { parentUuid: null }),
    prompt('<command-name>/x</command-name>', 1),
    prompt('meta', 2, { isMeta: true }),
    use('a', 'Bash', { command: 'ls' }, 3),
    result('a', 'out', 4),
    prompt('y'.repeat(300), 5),
  ])
  const { prompts } = buildTimeline({ main }).lanes[0]
  assert.deepEqual(prompts.map(p => p.at), [at(0), at(5)])
  assert.equal(prompts[0].text, 'first line')
  assert.equal(prompts[1].text.length, 200)
})

test('timeline: the call cap keeps the newest calls and reports the rest', () => {
  const main = ix([use('a', 'Bash', {}, 1), use('b', 'Bash', {}, 2), use('c', 'Bash', {}, 3), result('a', 'x', 4, { isError: true })])
  const [lane] = buildTimeline({ main, callCap: 2 }).lanes
  assert.deepEqual(lane.calls.map(c => c.id), ['b', 'c'])
  assert.equal(lane.truncated, 1)
  assert.equal(buildTimeline({ main }).lanes[0].truncated, 0)
  assert.equal(buildTimeline({ main }).lanes[0].calls[0].isError, true)
})

test('timeline: a parent loop from bad meta falls back to main', () => {
  const main = ix([prompt('go', 0)])
  const X = sub('X', [use('x1', 'Agent', {}, 1)], { toolUseId: 'y1' })
  const Y = sub('Y', [use('y1', 'Agent', {}, 2)], { toolUseId: 'x1' })
  const t = buildTimeline({ main, subagents: [X, Y] })
  assert.equal(t.lanes.length, 3)
  assert.ok(t.lanes.slice(1).every(l => l.depth >= 1))
})

test('a file replaced by one of the same or larger size (new inode) is re-read from the start', () => {
  const file = write([prompt('old', 0), use('a', 'Bash', { command: 'old' }, 1)])
  const ix = load(file)
  assert.equal(ix.detail().calls[0].id, 'a')
  const next = join(root, `rot${n++}.jsonl`)
  writeFileSync(next, [prompt('new', 0), use('zzzzzzzz', 'Bash', { command: 'new new new new new new' }, 1), use('b', 'Read', { file_path: '/y' }, 2)].map(line).join(''))
  renameSync(next, file)
  assert.equal(ix.update(), true)
  assert.deepEqual(ix.detail().calls.map(c => c.id).sort(), ['b', 'zzzzzzzz'])
})

test('a persisted output is read up to OUTPUT_CAP bytes only', () => {
  const big = join(root, `big${n++}.txt`)
  writeFileSync(big, 'x'.repeat(OUTPUT_CAP * 5))
  const file = write([use('a', 'Bash', { command: 'cat' }, 1), result('a', 'preview', 2, { tur: { persistedOutputPath: big } })])
  const out = load(file, { root }).detail().calls[0].output
  assert.ok(out.startsWith('x'.repeat(OUTPUT_CAP)))
  assert.match(out, /truncated, 40000 bytes/)
  assert.ok(out.length < OUTPUT_CAP + 100)
})

test('deeply nested inputs are cut instead of recursing without bound', () => {
  let deep = 'leaf'
  for (let i = 0; i < 5000; i++) deep = { a: deep }
  const ix = load(write([use('a', 'Bash', deep, 1)]))
  assert.match(JSON.stringify(ix.detail().calls[0].input), /\[nested\]/)
})

test('slim index keeps no inputs or outputs, and calls beyond the cap are dropped and counted', () => {
  const recs = []
  for (let i = 0; i < 12; i++) recs.push(use(`c${i}`, 'Bash', { command: `cmd ${i}` }, i), result(`c${i}`, 'out', i))
  const file = write(recs)
  const slim = load(file, { slim: true })
  const call = [...slim.state.calls.values()][0]
  assert.equal(call.input, null)
  assert.equal(call.output, null)
  assert.equal(call.hint, 'cmd 0')
  const capped = new TranscriptIndex(file, { slim: true })
  capped.state.maxCalls = 5
  capped.update()
  const tl = buildTimeline({ main: capped })
  assert.equal(tl.lanes[0].calls.length, 5)
  assert.equal(tl.lanes[0].truncated, 7)
  assert.equal(tl.lanes[0].calls[4].id, 'c11')
})
