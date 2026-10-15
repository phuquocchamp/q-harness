// Detects an answer that claims success ("tests pass", "all green", "done", "fixed"). Conservative on purpose:
// a negated, hedged, partial or questioned claim does not count, and any admitted failure cancels the claim.

const NEGATOR = /\b(?:not|no|never|none|nor|neither|without|cannot|can't|won't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|didn't|don't|doesn't|couldn't|shouldn't|wouldn't|almost|nearly|partially|yet)\b|n't\b/i
const HEDGE = /\b(?:if|once|until|unless|when|whether|should|will|would|could|may|might|must|need|needs|to|ensure|make sure|verify|check|expect|hope|hopefully|probably|likely|assume|try|trying|before|after)\b/i
const PARTIAL = /\b(?:some|most|only|few|several|half|many)\b/i
// "failing" is left to ADMISSION, so "fixed the failing test" still counts as a claim.
const FAILURE = /\b(?:fail|fails|failed|broken)\b(?!\s+(?:tests?|specs?|checks?)\b)/i
const RATIO = /\b(\d+)\s*(?:\/|of|out of)\s*(\d+)\b/gi
/** "some", "most", "3 of 5", "3/5" make a claim partial; "14/14" does not. */
const isPartial = (s: string) => PARTIAL.test(s) || [...s.matchAll(RATIO)].some(m => m[1] !== m[2])

const TEST_NOUN = '(?:(?:e2e|end-to-end|playwright|unit|integration|the|my|our|your|\\d+)\\s+)*(?:tests?|specs?|checks?|test suite|suite|build|ci)'
const CLAIMS: RegExp[] = [
  new RegExp(`\\b${TEST_NOUN}\\s+(?:are\\s+|is\\s+|have\\s+|has\\s+|all\\s+)?(?:now\\s+|all\\s+)?(?:pass|passes|passed|passing|green|succeed|succeeds|succeeded|succeeding)\\b`, 'i'),
  /\ball\s+(?:\d+\s+)?(?:(?:tests?|specs?|checks?)\s+)?(?:are\s+|have\s+)?(?:now\s+)?(?:pass|passed|passing|green)\b/i,
  /\beverything\s+(?:is\s+)?(?:passes|passing|green|works|working)\b/i,
]
// "done" and "fixed" only as a statement: at the start of a clause, or after a subject/auxiliary, and not "done by"/"fixed width".
const STATE_CLAIMS: RegExp[] = [
  /^(?:all\s+)?(?:done|fixed|complete|completed)\s*(?:[.!:—–-]|$|and\b|now\b)/i,
  /\b(?:i'm|i am|we're|we are|it's|it is|that's|that is|everything's|everything is|all|now|is|are|was|were|been|has been|have been)\s+(?:all\s+|now\s+|fully\s+)?(?:done|fixed|complete|completed)\s*(?:[.!:—–-]|$|and\b|now\b)/i,
  /\b(?:i|we|i've|we've|i have|we have)\s+(?:now\s+|also\s+)?(?:fixed|finished|completed)\b/i,
  /^fixed\s+(?:the|a|an|this|that|it|both|all|\w+'s)\b/i,
]
/** Admitted failures anywhere in the answer cancel a claim: "2 tests fail", "3 failed", "tests are still failing". */
const ADMISSION = [
  /\b(?:tests?|specs?|checks?)\s+(?:still\s+|are\s+still\s+|is\s+still\s+)?(?:fail|fails|are failing|is failing|are red|are broken)\b/i,
  /\b(?:[1-9]\d*|one|two|three|some|several|a few)\s+(?:tests?\s+|specs?\s+)?(?:still\s+)?(?:failed|failing|failures?|fail)\b/i,
  /\bstill\s+(?:failing|red|broken)\b/i,
]

const stripCode = (s: string) => s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')

/** Splits into sentences, keeping the terminator so questions can be told apart. */
const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean)
/** Splits a sentence into clauses; negation and hedges only look back within a clause. */
const clauses = (s: string) => s.split(/[,;]|\s(?:but|however|although|though|except|while)\s/i).map(x => x.trim().replace(/^[-*>#\s]+/, '')).filter(Boolean)

function clauseClaims(clause: string): boolean {
  for (const re of [...CLAIMS, ...STATE_CLAIMS]) {
    const m = re.exec(clause)
    if (!m) continue
    const before = clause.slice(0, m.index)
    const inside = m[0]
    if (NEGATOR.test(before) || NEGATOR.test(inside) || HEDGE.test(before) || isPartial(before + inside)) continue
    if (FAILURE.test(clause)) continue
    return true
  }
  return false
}

/** True when the answer states that the work is finished or the tests pass, without negation, hedging or admitted failures. */
export function claimsSuccess(answer: string): boolean {
  const text = stripCode(answer)
  if (ADMISSION.some(re => re.test(text))) return false
  for (const s of sentences(text)) {
    if (s.endsWith('?')) continue
    if (clauses(s).some(clauseClaims)) return true
  }
  return false
}
