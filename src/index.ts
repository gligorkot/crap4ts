/**
 * Public API surface for crap4ts.
 *
 * @packageDocumentation
 */

export {
  computeCrap,
  evaluateThreshold,
  assertRange,
  assertIntegerAtLeast,
  isFiniteNumber,
  DEFAULT_THRESHOLD,
  EXIT_THRESHOLD_EXCEEDED,
  EXIT_INVALID_INPUT,
} from "./crap.js";

export {
  validateSelfScoreBreach,
  EXPECTED_BREACH_NAMES,
} from "./self-score-helpers.js";

export type {
  CrapResult,
  ThresholdOutcome,
} from "./crap.js";

export type {
  SelfScoreReport,
  SelfScoreRow,
} from "./self-score-helpers.js";
