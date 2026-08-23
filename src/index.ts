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

export type {
  CrapResult,
  ThresholdOutcome,
} from "./crap.js";
