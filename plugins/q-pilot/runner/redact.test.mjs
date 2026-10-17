import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, redactDeep, redactValue, REDACTED } from './redact.mjs'

test('exact secrets are replaced, longest first', () => {
  assert.equal(redact('mail buyer@example.test now', ['buyer@example.test']), `mail ${REDACTED} now`)
  assert.equal(redact('abcdef abcd', ['abcd', 'abcdef']), `${REDACTED} ${REDACTED}`)
})

test('secrets shorter than 4 chars are ignored in text, but a field value that equals one is replaced whole', () => {
  assert.equal(redact('a 12 b', ['12']), 'a 12 b')
  assert.equal(redactValue('12', ['12']), REDACTED)
  assert.equal(redactValue('', ['']), '')
})

test('cookies, authorization, bearer, password fields and JWTs', () => {
  assert.equal(redact('Cookie: sid=abc; x=y'), `Cookie: ${REDACTED}`)
  assert.equal(redact('Authorization: Bearer abc123def456'), `Authorization: ${REDACTED}`)
  assert.equal(redact('use Bearer abc123def456 here'), `use Bearer ${REDACTED} here`)
  assert.equal(redact('?password=hunter22&a=1'), `?password=${REDACTED}&a=1`)
  assert.equal(redact('{"api_key": "k-123"}'), `{"api_key": "${REDACTED}"}`)
  assert.equal(redact('t=eyJhbGciOi.eyJzdWIiOi.sig'), `t=${REDACTED}`)
  assert.equal(redact('Token expired, Basic plan'), 'Token expired, Basic plan')
})

test('redactDeep walks objects and arrays', () => {
  assert.deepEqual(redactDeep({ a: ['x secret-value y'], n: 1 }, ['secret-value']), { a: [`x ${REDACTED} y`], n: 1 })
})
