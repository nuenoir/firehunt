// Tests for the query-string validators of the public search endpoints. The point of
// these checks is that nothing an attacker types ever reaches the upstream URL, so
// most of the cases below are hostile strings that must be refused with a 400.

import { describe, expect, it } from "vitest";
import { ADZUNA_COUNTRIES } from "@/lib/adzuna";
import { GULF_LOCATIONS } from "@/lib/jooble";
import { LIMITS } from "@/lib/limits";
import {
  ALL_GULF,
  JOOBLE_KEYWORD_LIMIT,
  parseAdzunaSearch,
  parseJoobleSearch,
  type SearchParamsError,
} from "./searchParams";

/** Query parameters built the way the browser builds them (so values are decoded once). */
const params = (obj: Record<string, string>) => new URLSearchParams(obj);

/** Query parameters as the server sees them for a raw URL: percent-escapes decoded once. */
const fromUrl = (query: string) =>
  new URL(`https://x.test/api/search?${query}`).searchParams;

/** Assert a request was refused with a 400 and a readable message; return the message. */
function expectRefused(result: { ok: boolean }): string {
  expect(result.ok).toBe(false);
  const refused = result as SearchParamsError;
  expect(refused.status).toBe(400);
  expect(typeof refused.error).toBe("string");
  expect(refused.error.length).toBeGreaterThan(10);
  return refused.error;
}

/** A short, readable label for a test case (some attack strings are thousands of characters). */
const show = (text: string) =>
  JSON.stringify(text.length > 40 ? `${text.slice(0, 20)}...(${text.length} chars)` : text);

/** Turn a list of strings into [label, value] rows for it.each. */
const cases = (values: string[]) => values.map((v) => [show(v), v] as const);

describe("parseAdzunaSearch: accepts what the search page really sends", () => {
  it("returns the clean values for a normal request", () => {
    const result = parseAdzunaSearch(
      params({ country: "gb", what: "data analyst", where: "London", page: "3", sort: "date" }),
    );
    expect(result).toEqual({
      ok: true,
      country: "gb",
      page: "3",
      what: "data analyst",
      where: "London",
      sort: "date",
    });
  });

  it("falls back to today's defaults when parameters are absent", () => {
    expect(parseAdzunaSearch(new URLSearchParams())).toEqual({
      ok: true,
      country: "au",
      page: "1",
      what: "",
      where: "",
      sort: "relevance",
    });
  });

  it("treats an empty country like a missing one (Australia, as always)", () => {
    const result = parseAdzunaSearch(params({ country: "" }));
    expect(result).toMatchObject({ ok: true, country: "au" });
  });

  it("accepts every country the search page offers, in any letter case", () => {
    for (const { code } of ADZUNA_COUNTRIES) {
      expect(parseAdzunaSearch(params({ country: code }))).toMatchObject({ ok: true, country: code });
      expect(parseAdzunaSearch(params({ country: code.toUpperCase() }))).toMatchObject({
        ok: true,
        country: code,
      });
    }
  });

  it("accepts sort values 'relevance', 'date' and empty", () => {
    expect(parseAdzunaSearch(params({ sort: "relevance" }))).toMatchObject({ ok: true, sort: "relevance" });
    expect(parseAdzunaSearch(params({ sort: "date" }))).toMatchObject({ ok: true, sort: "date" });
    expect(parseAdzunaSearch(params({ sort: "" }))).toMatchObject({ ok: true, sort: "relevance" });
  });

  it("accepts the first and last allowed page", () => {
    expect(parseAdzunaSearch(params({ page: "1" }))).toMatchObject({ ok: true, page: "1" });
    const last = String(LIMITS.search.maxPage);
    expect(parseAdzunaSearch(params({ page: last }))).toMatchObject({ ok: true, page: last });
  });
});

describe("parseAdzunaSearch: country can never steer the upstream path", () => {
  const attacks = [
    "../../x",
    "..",
    ".",
    "gb/../../jobs",
    "gb/",
    "/gb",
    "gb?x=1",
    "gb#frag",
    "gb\\..",
    "gb;x",
    "gb%2f..", // an escaped slash that survived one decode (double-encoded on the wire)
    "%2e%2e%2f",
    " gb",
    "gb ",
    "gb\n",
    "gb\0",
    "g",
    "gbr",
    "xx",
    "__proto__",
    "constructor",
    "toString",
    "ＧＢ", // full-width letters
    "İt", // dotted capital I + t: lower-cases to "i" + a combining dot + "t", not "it"
    "ġb", // a combining dot between the letters
    "a".repeat(5000),
  ];

  it.each(cases(attacks))("refuses country=%s", (_label, country) => {
    const message = expectRefused(parseAdzunaSearch(params({ country })));
    expect(message).toMatch(/country/i);
  });

  it("refuses an escaped slash that arrives decoded (?country=gb%2f..)", () => {
    expectRefused(parseAdzunaSearch(fromUrl("country=gb%2f..")));
  });

  it("does not repeat the attacker's string back in the message", () => {
    const message = expectRefused(parseAdzunaSearch(params({ country: "../../secret-path" })));
    expect(message).not.toContain("secret-path");
  });
});

describe("parseAdzunaSearch: page must be a plain whole number from 1 to the maximum", () => {
  const attacks = [
    "",
    "0",
    "-1",
    "+2",
    "1.5",
    "1e3",
    "0x10",
    "01", // no leading zeros: there is exactly one spelling of each page
    " 2",
    "2 ",
    "2\n",
    "1/../../../x",
    "2/../x",
    "2?app_key=evil",
    "2#x",
    "NaN",
    "Infinity",
    "99999999999999999999",
    "٢", // Arabic-Indic digit two
    "２", // full-width digit two
    "1\0",
    "9".repeat(5000),
  ];

  it.each(cases(attacks))("refuses page=%s", (_label, page) => {
    const message = expectRefused(parseAdzunaSearch(params({ page })));
    expect(message).toMatch(/page/i);
  });

  it("refuses the page just beyond the maximum, with a helpful message", () => {
    const message = expectRefused(parseAdzunaSearch(params({ page: String(LIMITS.search.maxPage + 1) })));
    expect(message).toContain(String(LIMITS.search.maxPage));
  });
});

describe("parseAdzunaSearch: keywords and city", () => {
  it("trims surrounding whitespace but keeps the words inside", () => {
    expect(parseAdzunaSearch(params({ what: "  product  manager ", where: " Amsterdam " }))).toMatchObject({
      ok: true,
      what: "product  manager",
      where: "Amsterdam",
    });
  });

  it("accepts ordinary non-English text and emoji", () => {
    expect(parseAdzunaSearch(params({ what: "café ingénieur 日本語 🚀", where: "Zürich" }))).toMatchObject({
      ok: true,
      what: "café ingénieur 日本語 🚀",
      where: "Zürich",
    });
  });

  it("treats a pasted tab or line break as a space instead of refusing an honest search", () => {
    expect(parseAdzunaSearch(params({ what: "data\tscience\r\nmanager" }))).toMatchObject({
      ok: true,
      what: "data science  manager",
    });
  });

  it("allows exactly the maximum length and refuses one more", () => {
    const max = LIMITS.search.text;
    expect(parseAdzunaSearch(params({ what: "a".repeat(max), where: "b".repeat(max) }))).toMatchObject({ ok: true });
    expectRefused(parseAdzunaSearch(params({ what: "a".repeat(max + 1) })));
    expectRefused(parseAdzunaSearch(params({ where: "b".repeat(max + 1) })));
  });

  it("refuses a 5,000-character keyword instead of cutting it short", () => {
    const message = expectRefused(parseAdzunaSearch(params({ what: "x".repeat(5000) })));
    expect(message).toContain(String(LIMITS.search.text));
  });

  it("counts characters, not UTF-16 units: 200 emoji are fine", () => {
    const emoji = "🚀".repeat(LIMITS.search.text); // 400 UTF-16 code units
    expect(parseAdzunaSearch(params({ what: emoji }))).toMatchObject({ ok: true, what: emoji });
    expectRefused(parseAdzunaSearch(params({ what: emoji + "🚀" })));
  });

  it("measures the length after trimming, so padding doesn't count against you", () => {
    const max = LIMITS.search.text;
    expect(parseAdzunaSearch(params({ what: ` ${"a".repeat(max)} ` }))).toMatchObject({ ok: true });
  });

  it.each([
    ["a null byte", "data\0analyst"],
    ["a bell", "data\u0007analyst"],
    ["an escape", "data\u001banalyst"],
    ["a DEL", "data\u007fanalyst"],
    ["a C1 control (NEL)", "data\u0085analyst"],
    ["a leading null byte", "\0"],
  ])("refuses %s in the keywords and in the city", (_name, text) => {
    expectRefused(parseAdzunaSearch(params({ what: text })));
    expectRefused(parseAdzunaSearch(params({ where: text })));
  });

  it("refuses every control character except ordinary whitespace, right up to the edges of each range", () => {
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i);
    // C0 controls minus tab/LF/VT/FF/CR, then DEL and the whole C1 block.
    const forbidden = [...range(0x00, 0x08), ...range(0x0e, 0x1f), ...range(0x7f, 0x9f)];
    for (const code of forbidden) {
      const text = `a${String.fromCharCode(code)}b`;
      expect(parseAdzunaSearch(params({ what: text })).ok, `U+${code.toString(16)} in keywords`).toBe(false);
      expect(parseAdzunaSearch(params({ where: text })).ok, `U+${code.toString(16)} in city`).toBe(false);
    }
    // Whitespace controls are normal whitespace, and the characters next to the
    // forbidden ranges (space, '!', no-break space, 'ý') are ordinary text.
    for (const code of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x21, 0xa0, 0xa1, 0xfd]) {
      const text = `a${String.fromCharCode(code)}b`;
      expect(parseAdzunaSearch(params({ what: text })).ok, `U+${code.toString(16)} is allowed`).toBe(true);
    }
  });

  it("refuses a null byte that arrives percent-encoded (?what=a%00b)", () => {
    expectRefused(parseAdzunaSearch(fromUrl("what=a%00b")));
  });

  it("accepts URL-looking text as plain text (it is encoded later, never spliced in)", () => {
    expect(parseAdzunaSearch(params({ what: "x&app_key=evil#../?" }))).toMatchObject({
      ok: true,
      what: "x&app_key=evil#../?",
    });
  });
});

describe("parseAdzunaSearch: sort", () => {
  it.each(cases(["DATE", "Relevance", "date ", " date", "price", "date,relevance", "date\0", "x".repeat(500)]))(
    "refuses sort=%s",
    (_label, sort) => {
      const message = expectRefused(parseAdzunaSearch(params({ sort })));
      expect(message).toMatch(/sort/i);
    },
  );
});

describe("parseJoobleSearch", () => {
  it("returns the clean values for a normal single-country request", () => {
    expect(parseJoobleSearch(params({ what: "data analyst London", location: "Qatar", page: "2" }))).toEqual({
      ok: true,
      what: "data analyst London",
      location: "Qatar",
      page: "2",
    });
  });

  it("accepts 'All Gulf' and every Gulf country the search page offers", () => {
    expect(parseJoobleSearch(params({ location: ALL_GULF }))).toMatchObject({ ok: true, location: "ALL_GULF" });
    for (const { location } of GULF_LOCATIONS) {
      expect(parseJoobleSearch(params({ location }))).toMatchObject({ ok: true, location });
    }
  });

  it("defaults to page 1 and empty keywords when they are absent", () => {
    expect(parseJoobleSearch(params({ location: "Oman" }))).toEqual({
      ok: true,
      what: "",
      location: "Oman",
      page: "1",
    });
  });

  it("trims the location and the keywords", () => {
    expect(parseJoobleSearch(params({ location: "  Kuwait ", what: " nurse " }))).toMatchObject({
      ok: true,
      location: "Kuwait",
      what: "nurse",
    });
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["blank", "   "],
    ["lower-case all-gulf", "all_gulf"],
    ["ALL_GULF with a path", "ALL_GULF/../x"],
    ["ALL_GULF with a null byte", "ALL_GULF\0"],
    ["two countries", "Qatar,Kuwait"],
    ["a country with a null byte", "Qatar\0"],
    ["wrong case", "qatar"],
    ["double space inside", "Saudi  Arabia"],
    ["an unknown place", "Narnia"],
    ["a prototype key", "__proto__"],
    ["a very long string", "Qatar".repeat(1000)],
  ])("refuses a location that is %s", (_name, location) => {
    const query = location === null ? new URLSearchParams() : params({ location });
    const message = expectRefused(parseJoobleSearch(query));
    expect(message).toMatch(/gulf/i);
  });

  it.each(cases(["", "0", "-1", "1.5", "1e3", " 2", "2/../x", "99999999999999999999", String(LIMITS.search.maxPage + 1)]))(
    "refuses page=%s",
    (_label, page) => {
      expectRefused(parseJoobleSearch(params({ location: "Qatar", page })));
    },
  );

  it("accepts the last allowed page", () => {
    const last = String(LIMITS.search.maxPage);
    expect(parseJoobleSearch(params({ location: "Qatar", page: last }))).toMatchObject({ ok: true, page: last });
  });

  it("allows the longest search the page can build (keywords + space + city)", () => {
    const max = LIMITS.search.text;
    const folded = `${"a".repeat(max)} ${"b".repeat(max)}`;
    expect(JOOBLE_KEYWORD_LIMIT).toBe(folded.length);
    expect(parseJoobleSearch(params({ location: "Qatar", what: folded }))).toMatchObject({ ok: true, what: folded });
  });

  it("refuses keywords beyond that, a 5,000-character string, and control characters", () => {
    const tooLong = "a".repeat(JOOBLE_KEYWORD_LIMIT + 1);
    expectRefused(parseJoobleSearch(params({ location: "Qatar", what: tooLong })));
    expectRefused(parseJoobleSearch(params({ location: "Qatar", what: "x".repeat(5000) })));
    expectRefused(parseJoobleSearch(params({ location: "Qatar", what: "a\0b" })));
    expectRefused(parseJoobleSearch(fromUrl("location=Qatar&what=a%00b")));
  });
});
