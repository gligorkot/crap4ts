import { describe, it, expect } from "vitest";
import {
  computeCrap,
  evaluateThreshold,
  assertRange,
  assertIntegerAtLeast,
  isFiniteNumber,
  DEFAULT_THRESHOLD,
  EXIT_THRESHOLD_EXCEEDED,
  EXIT_INVALID_INPUT,
} from "../src/crap.js";

describe("computeCrap", () => {
  it("returns complexity alone when coverage is 100% (additive term zero)", () => {
    expect(computeCrap(1, 1)).toStrictEqual({
      complexity: 1,
      coverage: 1,
      crap: 1,
    });
    expect(computeCrap(5, 1)).toStrictEqual({
      complexity: 5,
      coverage: 1,
      crap: 5,
    });
    expect(computeCrap(20, 1).crap).toBe(20);
  });

  it("returns complexity^2 + complexity when coverage is 0%", () => {
    const r = computeCrap(4, 0);
    // 4^2 * 1 + 4 = 20
    expect(r.crap).toBe(20);
    expect(r).toStrictEqual({ complexity: 4, coverage: 0, crap: 20 });
  });

  it("computes the additive term for partial coverage", () => {
    // complexity 2, coverage 0.5 -> uncovered 0.5
    // 2^2 * 0.5^3 + 2 = 4 * 0.125 + 2 = 2.5
    const r = computeCrap(2, 0.5);
    expect(r.crap).toBeCloseTo(2.5, 10);
  });

  it("is monotonic in coverage: lower coverage means higher CRAP for same complexity", () => {
    const low = computeCrap(6, 0.9).crap;
    const mid = computeCrap(6, 0.5).crap;
    const high = computeCrap(6, 0.1).crap;
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("is monotonic in complexity: higher complexity means higher CRAP for same coverage", () => {
    const a = computeCrap(2, 0.5).crap;
    const b = computeCrap(5, 0.5).crap;
    expect(a).toBeLessThan(b);
  });

  it("returns finite results across a range of complexity/coverage values", () => {
    for (let cc = 1; cc <= 50; cc++) {
      for (let cov = 0; cov <= 1; cov += 0.1) {
        const r = computeCrap(cc, Number(cov.toFixed(1)));
        expect(Number.isFinite(r.crap)).toBe(true);
      }
    }
  });

  it("preserves complexity=1 minimum (no branches -> additive term)", () => {
    const r = computeCrap(1, 0);
    expect(r.crap).toBe(2); // 1^2 * 1 + 1
  });
});

describe("evaluateThreshold", () => {
  it("breaches when CRAP is strictly greater than threshold", () => {
    const r = computeCrap(4, 0); // 20
    const outcome = evaluateThreshold(r, 8);
    expect(outcome.breached).toBe(true);
    expect(outcome.threshold).toBe(8);
  });

  it("does not breach at exactly the threshold (boundary inclusive)", () => {
    const r = computeCrap(2, 0.5); // 2.5
    const outcome = evaluateThreshold(r, 2.5);
    expect(outcome.breached).toBe(false);
  });

  it("uses DEFAULT_THRESHOLD = 8", () => {
    expect(DEFAULT_THRESHOLD).toBe(8);
  });

  it("rejects negative thresholds", () => {
    const r = computeCrap(1, 1);
    expect(() => evaluateThreshold(r, -1)).toThrow(RangeError);
  });

  it("rejects infinite thresholds", () => {
    const r = computeCrap(1, 1);
    expect(() => evaluateThreshold(r, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });
});

describe("assertRange", () => {
  it("accepts valid in-range values", () => {
    expect(() => assertRange(0, 0, 1, "coverage")).not.toThrow();
    expect(() => assertRange(1, 0, 1, "coverage")).not.toThrow();
    expect(() => assertRange(0.5, 0, 1, "coverage")).not.toThrow();
  });

  it("rejects NaN", () => {
    expect(() => assertRange(NaN, 0, 1, "coverage")).toThrow(RangeError);
  });

  it("rejects Infinity", () => {
    expect(() => assertRange(Infinity, 0, 1, "coverage")).toThrow(RangeError);
    expect(() => assertRange(-Infinity, 0, 1, "coverage")).toThrow(RangeError);
  });

  it("rejects out-of-range values", () => {
    expect(() => assertRange(1.5, 0, 1, "coverage")).toThrow(RangeError);
    expect(() => assertRange(-0.1, 0, 1, "coverage")).toThrow(RangeError);
  });
});

describe("assertIntegerAtLeast", () => {
  it("accepts integers >= min", () => {
    expect(() => assertIntegerAtLeast(1, 1, "complexity")).not.toThrow();
    expect(() => assertIntegerAtLeast(100, 1, "complexity")).not.toThrow();
  });

  it("rejects non-integers", () => {
    expect(() => assertIntegerAtLeast(1.5, 1, "complexity")).toThrow(RangeError);
  });

  it("rejects values below min", () => {
    expect(() => assertIntegerAtLeast(0, 1, "complexity")).toThrow(RangeError);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => assertIntegerAtLeast(NaN, 1, "complexity")).toThrow(RangeError);
    expect(() => assertIntegerAtLeast(Infinity, 1, "complexity")).toThrow(
      RangeError,
    );
  });
});

describe("isFiniteNumber", () => {
  it("accepts finite numbers", () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(42.5)).toBe(true);
    expect(isFiniteNumber(-1)).toBe(true);
  });

  it("rejects non-numbers", () => {
    expect(isFiniteNumber("1")).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
    expect(isFiniteNumber(true)).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
  });
});

describe("exit codes are distinct and non-zero for failures", () => {
  it("exposes distinct non-zero exit codes", () => {
    expect(EXIT_INVALID_INPUT).toBe(1);
    expect(EXIT_THRESHOLD_EXCEEDED).toBe(2);
    expect(EXIT_INVALID_INPUT).not.toBe(EXIT_THRESHOLD_EXCEEDED);
  });
});
