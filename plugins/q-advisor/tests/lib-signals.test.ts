import { expect, test } from 'claude-code/testing'

import type { Msg } from '../hooks/lib/contract'
import { extractCandidates, isTrivialPrompt, keepByRules, remainingWork, summarizeRecent } from '../hooks/lib/signals'

const user = (text: string): Msg => ({ role: 'user', text, toolUses: [] })
const assistant = (text: string, toolUses: Msg['toolUses'] = [], toolResults?: Msg['toolResults']): Msg => ({ role: 'assistant', text, toolUses, toolResults })
const todoWrite = (todos: { content: string; status: string }[]) => ({ tool: 'TodoWrite', input: { todos } })

const session: Msg[] = [
  user('Add a dark mode toggle to the settings page and persist it in localStorage.'),
  assistant('Plan: add a ThemeProvider, then wire the toggle.', [todoWrite([{ content: 'ThemeProvider', status: 'completed' }, { content: 'Toggle', status: 'in_progress' }, { content: 'Persist', status: 'pending' }, { content: 'Tests', status: 'pending' }])]),
  user("Let's go with CSS variables, not Tailwind dark: classes."),
  assistant('Done with the provider.', [
    { tool: 'Edit', input: { file_path: '/app/theme.ts' } },
    { tool: 'Write', input: { file_path: '/app/toggle.tsx' } },
    { tool: 'Edit', input: { file_path: '/app/theme.ts' } },
    { tool: 'NotebookEdit', input: { notebook_path: '/app/nb.ipynb' } },
  ]),
  user('ok'),
  assistant('Which storage key should I use?', [{ tool: 'AskUserQuestion', input: { questions: [{ question: 'Which storage key?' }] } }]),
]

test('isTrivialPrompt: slash commands, short text and acknowledgements', () => {
  expect(isTrivialPrompt('/compact now please', 5)).toBe(true)
  expect(isTrivialPrompt('fix it', 25)).toBe(true)
  for (const ack of ['ok', 'Okay', 'YES', 'Thanks!', 'thank you', 'continue', 'go on', 'next', 'LGTM', 'do it', 'hmm ok']) {
    expect(isTrivialPrompt(ack, 0)).toBe(true)
  }
  expect(isTrivialPrompt('now refactor the parser to stream tokens', 25)).toBe(false)
  expect(isTrivialPrompt('no, use the other approach instead', 5)).toBe(false)
})

test('summarizeRecent: condenses the last six messages and caps every field', () => {
  const r = summarizeRecent(session)
  expect(r.recentWork).toContain('User: Add a dark mode')
  expect(r.recentWork).toContain('[tools: Edit /app/theme.ts, Write /app/toggle.tsx')
  expect(r.recentWork.length).toBeLessThanOrEqual(1500)
  expect(r.lastReply).toBe('Which storage key should I use?')
  expect(r.todoState).toBe('3 of 4 open: Toggle; Persist; Tests')

  const long = summarizeRecent([assistant('x'.repeat(5000) + ' END')])
  expect(long.lastReply.length).toBe(1200)
  expect(long.lastReply.endsWith('END')).toBe(true)
  expect(summarizeRecent(Array.from({ length: 20 }, () => assistant('word '.repeat(60)))).recentWork.length).toBeLessThanOrEqual(1500)
})

test('summarizeRecent: todo state variants', () => {
  expect(summarizeRecent([user('hi')]).todoState).toBe('none')
  expect(summarizeRecent([assistant('', [todoWrite([{ content: 'a', status: 'completed' }])])]).todoState).toBe('all completed')
})

test('summarizeRecent: tool errors of the last turn only', () => {
  expect(summarizeRecent(session).toolErrors).toBe('none')
  const failed = [
    user('old turn'),
    assistant('', [{ tool: 'Grep', input: {}, isError: true }]),
    user('run the build and fix what breaks'),
    assistant('', [{ tool: 'Bash', input: {}, isError: true }, { tool: 'Edit', input: {}, isError: true }, { tool: 'Read', input: {} }]),
  ]
  expect(summarizeRecent(failed).toolErrors).toBe('2 tool errors: Bash, Edit')
  const viaResults = [user('do the thing now please'), assistant('', [{ tool: 'Bash', input: {} }], [{ isError: true }])]
  expect(summarizeRecent(viaResults).toolErrors).toBe('1 tool error')
})

test('extractCandidates: realistic session with deterministic ids', () => {
  const c = extractCandidates(session)
  expect(c.map((x) => x.kind)).toEqual(['goal', 'plan', 'decision', 'files', 'todo', 'open-question'])
  expect(c.map((x) => x.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
  expect(c[2]?.text).toBe("Let's go with CSS variables, not Tailwind dark: classes.")
  expect(c[3]?.text).toBe('Changed files: /app/theme.ts, /app/toggle.tsx, /app/nb.ipynb')
  expect(c[4]?.text).toBe('Open todos: Toggle; Persist; Tests')
  expect(c[5]?.text).toBe('Which storage key?')
})

test('extractCandidates: ExitPlanMode plan, reply ending in a question, answered questions', () => {
  const planned = [user('Build the export feature for reports please, CSV and JSON.'), assistant('', [{ tool: 'ExitPlanMode', input: { plan: '1. add exporter\n2. add tests' } }]), assistant('Shall I start with CSV?')]
  const c = extractCandidates(planned)
  expect(c.find((x) => x.kind === 'plan')?.text).toBe('1. add exporter\n2. add tests')
  expect(c.find((x) => x.kind === 'open-question')?.text).toBe('Shall I start with CSV?')
  expect(extractCandidates([...planned, user('yes, start with CSV')]).some((x) => x.kind === 'open-question')).toBe(false)
})

test('extractCandidates: short first prompt is not a goal; caps hold', () => {
  expect(extractCandidates([user('fix the bug')]).some((x) => x.kind === 'goal')).toBe(false)
  const many: Msg[] = [
    user('x'.repeat(900)),
    assistant('Plan: ' + 'y'.repeat(900)),
    ...Array.from({ length: 20 }, (_, i) => user(`Use approach number ${i} for the parser.`)),
    assistant('', Array.from({ length: 60 }, (_, i) => ({ tool: 'Edit', input: { file_path: `/some/long/path/file-${i}.ts` } }))),
  ]
  const c = extractCandidates(many)
  expect(c.length).toBeLessThanOrEqual(12)
  expect(c.filter((x) => x.kind === 'decision').length).toBe(5)
  expect(c.filter((x) => x.kind === 'decision').at(-1)?.text).toBe('Use approach number 19 for the parser.')
  expect(c.every((x) => x.text.length <= 400)).toBe(true)
})

test('remainingWork: todos, then a next sentence, then the goal', () => {
  expect(remainingWork(session)).toBe('Open todos: Toggle; Persist; Tests.')
  expect(remainingWork([user('Migrate the billing module to the new SDK version.'), assistant('Moved the client. Next, update the webhook handlers.')])).toBe('Next, update the webhook handlers.')
  expect(remainingWork([user('Migrate the billing module to the new SDK version.'), assistant("Moved the client. I'll update the webhook handlers after that.")])).toBe("I'll update the webhook handlers after that.")
  expect(remainingWork([assistant('Done. Remaining: migrate the docs.')])).toBe('Remaining: migrate the docs.')
})

test('remainingWork: never invents work from a third-person description', () => {
  const described = [user('Add a checkout test for the order flow please.'), assistant("I added tests/checkout.spec.ts. It then submits a fake email and expects 'Order confirmed'. The test then checks the next page.")]
  expect(remainingWork(described)).toBe('No open work; the last task looks finished.')
  expect(remainingWork([assistant('Next, it submits the form and then the test waits.')])).toBe('No open work; the last task looks finished.')
  expect(remainingWork([user('Migrate the billing module to the new SDK version.'), assistant('Moved the client.')])).toBe('No open work; the last task looks finished.')
  expect(remainingWork([])).toBe('No open work; the last task looks finished.')
})

test('keepByRules: keeps every candidate kind', () => {
  expect(keepByRules(extractCandidates(session))).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
  expect(keepByRules([])).toEqual([])
})
