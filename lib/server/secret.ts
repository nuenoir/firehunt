// lib/server/secret.ts
// SERVER-ONLY. Compares a secret the caller sent with the one we expect, in a way that
// takes the same time whether the first character is wrong or the last one is. (A plain
// `===` stops at the first difference, which in theory lets someone who can measure
// response times guess a secret one character at a time.)

import { createHash, timingSafeEqual } from "node:crypto";

export function secretsMatch(given: string, expected: string): boolean {
  // Hashing first gives two values of the same length, which timingSafeEqual needs and
  // which also hides how long the real secret is.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
