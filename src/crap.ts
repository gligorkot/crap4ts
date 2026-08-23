/**
 * Pure CRAP score computation and threshold evaluation.
 *
 * Formula: CRAP = cyclomaticComplexity^2 * (1 - coverage)^3 + cyclomaticComplexity
 *
 * Coverage is a decimal in [0, 1]. Cyclomatic complexity is an integer >= 1.
 *
 * @packageDocumentation
 */

/**
 * The default CRAP threshold used when none is supplied on the CLI.
 *
 * @remarks
 * The original crap4j metric uses 30; the task spec for crap4ts v1
 * mandates a default failure threshold of 8. A gate breach is any score
 * strictly greater than the threshold.
 */
export const DEFAULT_THRESHOLD = 8;

/**
 * Exit code returned by the CLI when the CRAP threshold is exceeded.
 */
export const EXIT_THRESHOLD_EXCEEDED = 2;

/**
 * Exit code returned by the CLI for invalid arguments or input.
 */
export const EXIT_INVALID_INPUT = 1;

/**
 * The outcome of a single function's CRAP evaluation.
 */
export interface CrapResult {
  readonly complexity: number;
  readonly coverage: number;
  readonly crap: number;
}

/**
 * A CRAP score plus a pass/fail determination against a threshold.
 */
export interface ThresholdOutcome {
  readonly result: CrapResult;
  /** True when `result.crap` is strictly greater than the threshold. */
  readonly breached: boolean;
  readonly threshold: number;
}

/**
 * Validate that a value is a finite, non-NaN number in the closed range
 * `[min, max]`.
 *
 * @throws {RangeError} when the value is NaN, infinite, or out of range.
 */
export function assertRange(
  value: number,
  min: number,
  max: number,
  label: string,
): void {
  if (Number.isNaN(value)) {
    throw new RangeError(`${label} must not be NaN`);
  }
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  if (value < min || value > max) {
    throw new RangeError(
      `${label} must be in [${min}, ${max}] but was ${value}`,
    );
  }
}

/**
 * Validate that a value is a finite, non-NaN integer >= `min`.
 *
 * @throws {RangeError} when the value is not a finite integer or is below `min`.
 */
export function assertIntegerAtLeast(
  value: number,
  min: number,
  label: string,
): void {
  if (Number.isNaN(value)) {
    throw new RangeError(`${label} must not be NaN`);
  }
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`${label} must be an integer but was ${value}`);
  }
  if (value < min) {
    throw new RangeError(`${label} must be >= ${min} but was ${value}`);
  }
}

/**
 * Maximum representable cyclomatic complexity before CRAP arithmetic risks
 * overflow. With the formula `cc^2 * uncovered^3 + cc`, the additive term
 * is bounded by `cc^2`. For `cc = 1e8`, `cc^2 = 1e16` which is within
 * safe integer range. We cap at a generous but finite bound to guard
 * against forged or pathological inputs while never affecting real code.
 */
const MAX_COMPLEXITY = 1_000_000;

/**
 * Compute the CRAP score for a single function.
 *
 * Formula: `complexity^2 * (1 - coverage)^3 + complexity`.
 *
 * Inputs are validated: `complexity` must be an integer >= 1 and `coverage`
 * must be a finite decimal in [0, 1]. The result is guaranteed finite and
 * non-NaN.
 *
 * Boundary behaviour:
 * - coverage 0  -> uncovered^3 = 1 -> `complexity^2 + complexity` (worst case)
 * - coverage 1  -> uncovered^3 = 0 -> `complexity` (fully covered, additive term zero)
 *
 * @throws {RangeError} on invalid inputs (NaN, Infinity, out of range,
 *   or complexity exceeding the overflow guard).
 */
export function computeCrap(complexity: number, coverage: number): CrapResult {
  assertIntegerAtLeast(complexity, 1, "complexity");
  assertRange(coverage, 0, 1, "coverage");
  if (complexity > MAX_COMPLEXITY) {
    throw new RangeError(
      `complexity must not exceed ${MAX_COMPLEXITY} to prevent CRAP arithmetic overflow, got ${complexity}`,
    );
  }

  const cc = complexity; // validated finite integer in [1, MAX_COMPLEXITY]
  const uncovered = 1 - coverage; // coverage in [0,1] -> uncovered in [0,1]
  const additive = cc * cc * uncovered * uncovered * uncovered;
  const crap = additive + cc;

  // Final safety net: the result must be finite and non-NaN.
  if (Number.isNaN(crap) || !Number.isFinite(crap)) {
    throw new RangeError(
      `CRAP computation produced a non-finite result (${crap}) for complexity=${complexity}, coverage=${coverage}`,
    );
  }

  return { complexity, coverage, crap };
}

/**
 * Evaluate a {@link CrapResult} against a threshold.
 *
 * @param result   - the computed CRAP result
 * @param threshold - maximum tolerated score; a breach is any score strictly
 *                   greater than this value
 * @throws {RangeError} when `threshold` is not a finite, non-negative number.
 */
export function evaluateThreshold(
  result: CrapResult,
  threshold: number,
): ThresholdOutcome {
  if (Number.isNaN(threshold)) {
    throw new RangeError("threshold must not be NaN");
  }
  if (!Number.isFinite(threshold)) {
    throw new RangeError("threshold must be finite");
  }
  if (threshold < 0) {
    throw new RangeError(`threshold must be >= 0 but was ${threshold}`);
  }
  // Guard against a forged NaN/Infinity crap score sneaking into evaluation.
  if (Number.isNaN(result.crap) || !Number.isFinite(result.crap)) {
    throw new RangeError(
      `cannot evaluate threshold against non-finite CRAP score: ${result.crap}`,
    );
  }
  const breached = result.crap > threshold;
  return { result, breached, threshold };
}

/**
 * Type guard: true when `value` is a finite, non-NaN number.
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
