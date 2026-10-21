import { describe, expect, it } from "vitest";
import {
  formatJavaToString, istNow, istToday, micros, parseLocalDateInput, parseLocalDateTimeInput, pgTextToJackson,
  secondsBetween, utcNow,
} from "../src/lib/time.js";

const at = (iso: string) => ({ now: () => Date.parse(iso) });

describe("Jackson LocalDateTime format", () => {
  it("converts Postgres text to ISO with T, keeping the fraction trimmed", () => {
    expect(pgTextToJackson("2026-10-17 13:09:00.905613")).toBe("2026-10-17T13:09:00.905613");
    expect(pgTextToJackson("2026-10-15 16:19:14.42763")).toBe("2026-10-15T16:19:14.42763");
    expect(pgTextToJackson("2026-10-17 11:31:01.381")).toBe("2026-10-17T11:31:01.381");
  });
  it("always prints seconds and omits a zero fraction (ISO_LOCAL_DATE_TIME)", () => {
    expect(pgTextToJackson("2026-10-13 11:38:00")).toBe("2026-10-13T11:38:00");
  });
  it("accepts JSON (jsonb) timestamps with T", () => {
    expect(pgTextToJackson("2026-10-13T11:38:00.5")).toBe("2026-10-13T11:38:00.5");
  });
});

describe("LocalDateTime#toString format", () => {
  it("drops zero seconds", () => expect(formatJavaToString(micros("2026-10-17T09:00:00"))).toBe("2026-10-17T09:00"));
  it("keeps non-zero seconds", () => expect(formatJavaToString(micros("2026-10-17T09:00:05"))).toBe("2026-10-17T09:00:05"));
  it("prints millis as 3 digits and micros as 6", () => {
    expect(formatJavaToString(micros("2026-10-17T09:00:00.381"))).toBe("2026-10-17T09:00:00.381");
    expect(formatJavaToString(micros("2026-10-15T16:19:14.42763"))).toBe("2026-10-15T16:19:14.427630");
  });
});

describe("Asia/Kolkata business clock", () => {
  it("is UTC+05:30", () => {
    expect(istNow(at("2026-10-17T04:30:00.123Z"))).toBe("2026-10-17T10:00:00.123");
  });
  it("rolls the business date at IST midnight, not UTC midnight", () => {
    // 18:29:59 UTC = 23:59:59 IST same day; 18:30 UTC = 00:00 IST next day.
    expect(istToday(at("2026-10-17T18:29:59Z"))).toBe("2026-10-17");
    expect(istToday(at("2026-10-17T18:30:00Z"))).toBe("2026-10-18");
    // 00:30 IST on the 18th is still the 17th in UTC — the case Spring got wrong for follow-ups.
    expect(istToday(at("2026-10-17T19:00:00Z"))).toBe("2026-10-18");
  });
  it("keeps the UTC wall clock for app-set created_at", () => {
    expect(utcNow(at("2026-10-17T04:30:00Z"))).toBe("2026-10-17T04:30:00");
  });
});

describe("durations", () => {
  it("floor seconds like Duration.getSeconds()", () => {
    expect(secondsBetween(micros("2026-10-17T10:00:00.999999"), micros("2026-10-17T10:00:01.000001"))).toBe(0);
    expect(secondsBetween(micros("2026-10-17T10:00:00"), micros("2026-10-17T10:35:00"))).toBe(2100);
    expect(secondsBetween(micros("2026-10-17T10:00:01"), micros("2026-10-17T10:00:00"))).toBe(-1);
  });
});

describe("request date parsing (Jackson-compatible)", () => {
  it("accepts minutes-only, seconds and fractions", () => {
    expect(parseLocalDateTimeInput("2026-10-13T11:38")).toBe("2026-10-13T11:38:00");
    expect(parseLocalDateTimeInput("2026-10-13T11:38:09.120")).toBe("2026-10-13T11:38:09.12");
  });
  it("converts a trailing Z to the UTC wall clock (Jackson leniency)", () => {
    expect(parseLocalDateTimeInput("2026-10-13T06:08:00.000Z")).toBe("2026-10-13T06:08:00");
  });
  it("rejects offsets, garbage and impossible dates", () => {
    expect(() => parseLocalDateTimeInput("2026-10-13T11:38+05:30")).toThrow();
    expect(() => parseLocalDateTimeInput("tomorrow")).toThrow();
    expect(() => parseLocalDateTimeInput("2026-02-31T10:00")).toThrow();
    expect(() => parseLocalDateInput("2026-13-01")).toThrow();
  });
});
