import { describe, expect, it } from "vitest";
import { lineTotal, percentDiscount, sum } from "../src/domain/money";

describe("money", () => {
  it("rounds percentage discounts half-up using integer arithmetic", () => {
    expect(percentDiscount(1999, 10)).toBe(200); // 199.9 -> 200
    expect(percentDiscount(1994, 10)).toBe(199); // 199.4 -> 199
    expect(percentDiscount(1995, 10)).toBe(200); // 199.5 -> 200 (half up)
    expect(percentDiscount(5, 10)).toBe(1); // 0.5 -> 1
    expect(percentDiscount(4, 10)).toBe(0); // 0.4 -> 0
    expect(percentDiscount(0, 10)).toBe(0);
  });

  it("never produces a discount larger than the amount (total can't go negative)", () => {
    expect(percentDiscount(1, 100)).toBe(1);
    expect(percentDiscount(999, 100)).toBe(999);
    for (let amount = 0; amount < 500; amount++) {
      for (const pct of [1, 7, 10, 33, 50, 99, 100]) {
        expect(percentDiscount(amount, pct)).toBeLessThanOrEqual(amount);
      }
    }
  });

  it("is deterministic and avoids float artefacts (e.g. 0.1 + 0.2)", () => {
    // 1 cent * 3 at 10% would be 0.3 in floats; integer math says 0.
    expect(percentDiscount(lineTotal(1, 3), 10)).toBe(0);
    expect(sum([10, 20, 30])).toBe(60);
    expect(lineTotal(1999, 3)).toBe(5997);
  });

  it("rejects values that could lose precision or are negative", () => {
    expect(() => lineTotal(Number.MAX_SAFE_INTEGER, 2)).toThrow();
    expect(() => lineTotal(-1, 1)).toThrow();
    expect(() => lineTotal(10, 0)).toThrow();
    expect(() => percentDiscount(100, 101)).toThrow();
  });
});
