import { expect, test } from 'claude-code/testing'

import type { SpecResult } from '../hooks/lib/contract'
import { DEFAULT_JEV_MODEL, HAIKU_LABEL_TEXT, JEV_URL, STATE_BUDGET, TRIAGE_LABELS, TRIAGE_QUESTIONS, extractAriaSnapshot, parseTriage, redact, retriesText, triageRequest } from '../hooks/lib/jev'

test('endpoint, labels and questions match the live-validated wording', () => {
  expect(JEV_URL).toBe('https://api.typesafe.ai/v1/systemone')
  expect(TRIAGE_LABELS).toEqual(['flaky', 'test-drift', 'app-bug', 'env-auth'])
  expect(TRIAGE_QUESTIONS.label.instructions).toBe('A Playwright end-to-end test failed. Classify the most likely cause of the failure.')
  expect(TRIAGE_QUESTIONS.label.criteria).toEqual({
    flaky: 'Timing or nondeterminism: passes on retry, or the expected element is actually present.',
    'test-drift': "The app changed on purpose (renamed text, moved element) and the test's locator or expectation is outdated.",
    'app-bug': 'The application behaves incorrectly; the test expectation is right.',
    'env-auth': 'Environment problem: server not running, network refused, login/session expired.',
  })
  expect(TRIAGE_QUESTIONS.touched).toEqual({ type: 'noul', instructions: 'Did the code change in turn_diff touch the feature this failing test exercises?' })
  expect(HAIKU_LABEL_TEXT['app-bug']).toBe(TRIAGE_QUESTIONS.label.criteria['app-bug'])
})

const SPEC: SpecResult = { file: 'tests/checkout.spec.ts', line: 42, title: 'pays', status: 'failed', durationMs: 10, retries: 1, error: "Expected: 'Paid'\nReceived: 'Pending'" }
const CTX = "# Test info\n\n- Name: pays\n\n# Error details\n\n```\nboom\n```\n\n# Page snapshot\n\n```yaml\n- heading \"Order #1042\"\n- status: Pending\n```\n"

test('the request carries the five state keys, the default model and the questions', () => {
  const body = JSON.parse(triageRequest({ spec: SPEC, errorContext: CTX, turnDiff: '-  await markPaid(order)' }))
  expect(body.model).toBe(DEFAULT_JEV_MODEL)
  expect(body.questions).toEqual(TRIAGE_QUESTIONS)
  expect(body.state).toEqual({
    spec: 'tests/checkout.spec.ts:42 › pays',
    error: "Expected: 'Paid'\nReceived: 'Pending'",
    aria_snapshot: '- heading "Order #1042"\n- status: Pending',
    turn_diff: '-  await markPaid(order)',
    retries: 'failed 2 of 2 runs',
  })
  expect(JSON.parse(triageRequest({ spec: SPEC, model: 'jev-1.13.0' })).model).toBe('jev-1.13.0')
})

test('retries wording and aria fallback', () => {
  expect(retriesText({ status: 'flaky', retries: 1 })).toBe('failed 1 of 2 runs, passed on retry')
  expect(retriesText({ status: 'failed', retries: 0 })).toBe('failed 1 of 1 runs')
  expect(extractAriaSnapshot('just text')).toBe('just text')
})

test('the request redacts secrets and stays near the budget, trimming the diff first', () => {
  const diff = `+ const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123"\n${'x'.repeat(60_000)}`
  const aria = `# Page snapshot\n\n\`\`\`yaml\n${'- item\n'.repeat(1000)}\`\`\``
  const raw = triageRequest({ spec: { ...SPEC, error: 'Cookie: sid=abc123' }, errorContext: aria, turnDiff: diff, secrets: ['hunter22'] })
  const { state } = JSON.parse(raw)
  expect(state.error).toBe('Cookie: [redacted]')
  expect(state.turn_diff).toContain('[redacted]')
  expect(state.turn_diff).toContain('…[truncated')
  expect(state.aria_snapshot.length).toBe(aria.length - '# Page snapshot\n\n```yaml\n'.length - '\n```'.length)
  const total = Object.values(state as Record<string, string>).reduce((n, v) => n + v.length, 0)
  expect(total <= STATE_BUDGET + 100).toBe(true)
})

test('redact: headers, bearer tokens, form/query/json values, JWTs and exact secrets', () => {
  expect(redact('Set-Cookie: session=abc; Path=/')).toBe('Set-Cookie: [redacted]')
  expect(redact('authorization: Bearer abc.def')).toBe('authorization: [redacted]')
  expect(redact('called with Bearer sk-123_abc')).toBe('called with Bearer [redacted]')
  expect(redact('{"cookie": "a=b", "x": 1}')).toBe('{"cookie": "[redacted]", "x": 1}')
  expect(redact('POST /login?user=a&password=hunter2&next=/')).toBe('POST /login?user=a&password=[redacted]&next=/')
  expect(redact('access_token=xyz token=abc client_secret=s3')).toBe('access_token=[redacted] token=[redacted] client_secret=[redacted]')
  expect(redact('{"password":"p@ss","name":"x"}')).toBe('{"password":"[redacted]","name":"x"}')
  expect(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-_x end')).toBe('jwt [redacted] end')
  expect(redact('user qa@example.com pass S3cretPass!', ['S3cretPass!', '', 'ab'])).toBe('user qa@example.com pass [redacted]')
  expect(redact('plain text with a ab b')).toBe('plain text with a ab b')
  expect(redact('+Cookie: sid=abc\n-Set-Cookie: x=1')).toBe('+Cookie: [redacted]\n-Set-Cookie: [redacted]')
  expect(redact('Error: Token expired')).toBe('Error: Token expired')
  expect(redact('+ <h1>Basic plan</h1>')).toBe('+ <h1>Basic plan</h1>')
  expect(redact('header bearer abc123def456')).toBe('header bearer [redacted]')
})

const answer = (label: unknown, touched: unknown = { type: 'noul', noul: 0.94 }) =>
  JSON.stringify({ model: 'jev-1.13.0', answers: { label, touched }, usage: { input_tokens: 560 } })
const GOOD = { type: 'choice', choice: 'app-bug', confidence: 0.97, probabilities: { flaky: 0.01, 'test-drift': 0.01, 'app-bug': 0.97, 'env-auth': 0.01 } }

test('parseTriage accepts a valid answer', () => {
  expect(parseTriage(answer(GOOD))).toEqual({
    label: 'app-bug',
    p: 0.97,
    probabilities: { flaky: 0.01, 'test-drift': 0.01, 'app-bug': 0.97, 'env-auth': 0.01 },
    touched: 0.94,
    source: 'jev',
  })
  expect(parseTriage(answer(GOOD, { type: 'noul', noul: 2 }))?.touched).toBeUndefined()
  expect(parseTriage(answer(GOOD, undefined))?.label).toBe('app-bug')
})

test('parseTriage rejects what validate_choice rejects', () => {
  const bad = (over: Record<string, unknown>) => parseTriage(answer({ ...GOOD, ...over }))
  expect(bad({ choice: 'other' })).toBeUndefined()
  expect(bad({ choice: 'flaky' })).toBeUndefined() // not the argmax
  expect(bad({ confidence: 1.5 })).toBeUndefined()
  expect(bad({ confidence: undefined })).toBeUndefined()
  expect(bad({ probabilities: { flaky: 0.5, 'test-drift': 0.1, 'app-bug': 0.5, 'env-auth': 0.1 } })).toBeUndefined() // sum 1.2
  expect(bad({ probabilities: { 'app-bug': 1 } })).toBeUndefined() // missing labels
  expect(bad({ probabilities: { flaky: 0, 'test-drift': 0, 'app-bug': 1, 'env-auth': 0, extra: 0 } })).toBeUndefined()
  expect(bad({ probabilities: { flaky: -0.01, 'test-drift': 0.02, 'app-bug': 0.99, 'env-auth': 0 } })).toBeUndefined()
  expect(parseTriage('{"error":"unauthorized"}')).toBeUndefined()
  expect(parseTriage('<html>')).toBeUndefined()
  expect(parseTriage('null')).toBeUndefined()
})
