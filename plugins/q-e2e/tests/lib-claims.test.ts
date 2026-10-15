import { expect, test } from 'claude-code/testing'

import { claimsSuccess } from '../hooks/lib/claims'

test('plain success claims count', () => {
  for (const s of [
    'All tests pass.',
    'The e2e tests are passing now.',
    'ALL PASSED',
    'Everything is green.',
    'All green!',
    'Done.',
    "Done — the checkout button now says 'Pay'.",
    'Fixed the failing test by updating the locator.',
    "I've fixed the login redirect.",
    'The bug is fixed.',
    'all 14 tests pass',
    '14/14 specs pass.',
    'Updated the form. The playwright tests passed.',
    "That's done and the suite passes.",
  ]) expect([s, claimsSuccess(s)]).toEqual([s, true])
})

test('negated, hedged, partial, questioned or contradicted claims do not count', () => {
  for (const s of [
    'Not all tests pass.',
    'The tests fail on CI.',
    "Tests don't pass yet.",
    'Some tests pass, but checkout still fails.',
    '3 of 5 tests pass.',
    '3/5 specs pass.',
    'Do all tests pass?',
    'Once the tests pass, I will merge.',
    'Run the suite to make sure all tests pass.',
    'The tests should pass now.',
    'Done reading the file; next I will edit the form.',
    'This is done by calling markPaid().',
    'The header uses a fixed width.',
    "I haven't fixed the redirect yet.",
    'Fixed the layout. 2 tests still fail.',
    'Done. checkout.spec.ts is still failing.',
    'No tests ran.',
    'The `tests pass` string is printed by the runner.',
    'Here is the plan for the refactor.',
    '',
  ]) expect([s, claimsSuccess(s)]).toEqual([s, false])
})
