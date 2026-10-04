/**
 * Money rules.
 *
 * All amounts are integers in the currency's minor unit (e.g. cents). They are
 * stored as SQLite INTEGER, transported in JSON as integers, and never touch a
 * floating point number during arithmetic. JavaScript numbers are exact
 * integers up to 2^53-1 (~90 trillion dollars in cents), which is far beyond
 * anything this service will see; `assertSafeMoney` enforces that bound so a
 * silent precision loss cannot occur.
 */

export function assertSafeMoney(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer, got ${value}`);
  }
  return value;
}

/** unitPrice * quantity with overflow protection. */
export function lineTotal(unitPriceMinor: number, quantity: number): number {
  assertSafeMoney(unitPriceMinor, "unitPrice");
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error(`quantity must be a positive integer, got ${quantity}`);
  }
  return assertSafeMoney(unitPriceMinor * quantity, "lineTotal");
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => assertSafeMoney(acc + v, "sum"), 0);
}

/**
 * Percentage discount, rounded half-up to the nearest minor unit, clamped so it
 * can never exceed the amount it is applied to (guaranteeing a non-negative
 * total). Pure integer arithmetic:
 *
 *   floor((amount * percent + 50) / 100)
 *
 * Examples (percent = 10): 1999 -> 200 (199.9 rounds up), 1994 -> 199, 5 -> 1 (0.5 rounds up).
 */
export function percentDiscount(amountMinor: number, percent: number): number {
  assertSafeMoney(amountMinor, "amount");
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error(`percent must be an integer in [0, 100], got ${percent}`);
  }
  const raw = Math.floor((amountMinor * percent + 50) / 100);
  return Math.min(raw, amountMinor);
}
