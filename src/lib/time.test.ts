import { describe, expect, it } from "vitest";
import { formatClock, formatInterval, formatTimestamp, parseTimestamp, spokenTimestamp } from "./time";

describe("timestamps", () => {
  it("formats mm:ss below one hour and h:mm:ss from one hour", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(754_900)).toBe("12:34");
    expect(formatTimestamp(3_725_000)).toBe("1:02:05");
    expect(formatTimestamp(5_000, 3_600_000)).toBe("0:00:05");
    expect(formatClock(754_000)).toBe("00:12:34");
    expect(formatInterval(750_000, 900_000)).toBe("12:30–15:00");
    expect(spokenTimestamp(754_000)).toBe("12 minuti e 34 secondi");
  });

  it("parses typed times and rejects invalid ones", () => {
    expect(parseTimestamp("12:30")).toBe(750_000);
    expect(parseTimestamp("1:02:05")).toBe(3_725_000);
    expect(parseTimestamp("45")).toBe(45_000);
    expect(parseTimestamp("0:07,5")).toBe(7_500);
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("12:75")).toBeNull();
    expect(parseTimestamp("1:60:00")).toBeNull();
    expect(parseTimestamp("ab:cd")).toBeNull();
    expect(parseTimestamp("-1:00")).toBeNull();
  });
});
