import { describe, expect, test } from "bun:test";
import { parseTimeArg } from "./time.ts";

const NOW = Date.parse("2026-06-28T12:00:00.000Z");

describe("parseTimeArg", () => {
  test("parses day offsets", () => {
    expect(parseTimeArg("7d", NOW)).toBe(NOW - 7 * 86_400_000);
  });

  test("parses hour and minute offsets", () => {
    expect(parseTimeArg("24h", NOW)).toBe(NOW - 24 * 3_600_000);
    expect(parseTimeArg("30m", NOW)).toBe(NOW - 30 * 60_000);
  });

  test("parses ISO timestamps", () => {
    expect(parseTimeArg("2026-06-21", NOW)).toBe(Date.parse("2026-06-21"));
  });

  test("rejects unknown formats", () => {
    expect(() => parseTimeArg("last-week", NOW)).toThrow(/Invalid time/);
  });
});
