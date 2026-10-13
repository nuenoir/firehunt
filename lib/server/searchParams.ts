// lib/server/searchParams.ts
// Strict checks on the query string of the two PUBLIC job-search endpoints
// (/api/adzuna and /api/jooble). Anyone on the internet can call them, and they
// forward what they are given to a paid upstream API with OUR secret key attached.
// So nothing is passed on as-is: every value is checked here first, and the routes
// build the upstream request only from the clean values this file returns.
//
// The clean values returned for the country and the Gulf location are copied from
// our own allow-lists (ADZUNA_COUNTRIES / GULF_LOCATIONS), never from the request,
// so even a clever string that sneaks past a check cannot reach the upstream URL.
//
// Pure functions (no I/O), so they are cheap to run BEFORE the rate-limit check:
// a malformed request costs no database round-trip. Bad input is refused with a 400
// and a message written for people (the search page shows it as-is), never silently
// shortened - a half-searched keyword would quietly return the wrong jobs.

import { ADZUNA_COUNTRIES } from "@/lib/adzuna";
import { GULF_LOCATIONS } from "@/lib/jooble";
import { LIMITS } from "@/lib/limits";

/** The request was refused. `error` is safe to show to the person searching. */
export interface SearchParamsError {
  ok: false;
  status: 400;
  error: string;
}

export interface AdzunaSearch {
  ok: true;
  /** Lower-case Adzuna country code, copied from ADZUNA_COUNTRIES. */
  country: string;
  /** Plain digits, "1" to String(LIMITS.search.maxPage). */
  page: string;
  /** Keywords: trimmed, possibly empty. */
  what: string;
  /** City / area: trimmed, possibly empty. */
  where: string;
  sort: "relevance" | "date";
}

export interface JoobleSearch {
  ok: true;
  /** Keywords: trimmed, possibly empty. */
  what: string;
  /** "ALL_GULF", or one GULF_LOCATIONS[].location exactly. */
  location: string;
  /** Plain digits, "1" to String(LIMITS.search.maxPage). */
  page: string;
}

/** The "search all six Gulf countries at once" location value. */
export const ALL_GULF = "ALL_GULF";

/** What the Jooble keywords field may hold. The search page folds the optional city
 *  into the keywords for Jooble ("keywords city"), so an honest search can carry one
 *  keywords field, a space and one city field, each up to LIMITS.search.text. */
export const JOOBLE_KEYWORD_LIMIT = LIMITS.search.text * 2 + 1;

function refuse(error: string): SearchParamsError {
  return { ok: false, status: 400, error };
}

/** Control characters that are NOT ordinary whitespace: NUL, bell, escape, DEL and
 *  the C1 range. No real search contains them. (Tab, line feed, vertical tab, form
 *  feed and carriage return are handled as whitespace instead.) */
function isForbiddenControl(code: number): boolean {
  return (
    code <= 0x08 ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

function hasForbiddenControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isForbiddenControl(text.charCodeAt(i))) return true;
  }
  return false;
}

/** A free-text field: absent means "", whitespace is trimmed, and it must be at
 *  most `maxChars` characters (counted as characters, not UTF-16 code units, so a
 *  box that allows `maxChars` code units can never be refused here). `field` is the
 *  plain-language name used in the error message, e.g. "keywords". */
function cleanText(
  raw: string | null,
  field: string,
  maxChars: number,
): { ok: true; value: string } | SearchParamsError {
  if (raw === null) return { ok: true, value: "" };
  if (hasForbiddenControl(raw)) {
    return refuse(`Please remove the unusual characters from the ${field}.`);
  }
  // A pasted tab or line break is just whitespace: treat it as a space.
  const value = raw.replace(/[\t\n\v\f\r]/g, " ").trim();
  if (Array.from(value).length > maxChars) {
    return refuse(`The ${field} can be at most ${maxChars} characters.`);
  }
  return { ok: true, value };
}

/** A results page: plain ASCII digits, no sign / decimal / exponent / spaces / leading
 *  zero, between 1 and LIMITS.search.maxPage. Absent means page 1. */
function cleanPage(
  raw: string | null,
): { ok: true; page: string } | SearchParamsError {
  if (raw === null) return { ok: true, page: "1" };
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return refuse("The page number must be a whole number, starting at 1.");
  }
  if (Number(raw) > LIMITS.search.maxPage) {
    return refuse(
      `Results stop at page ${LIMITS.search.maxPage}. Try more specific keywords or a city to narrow the search.`,
    );
  }
  return { ok: true, page: raw };
}

/** Check the query string of GET /api/adzuna. */
export function parseAdzunaSearch(
  searchParams: URLSearchParams,
): AdzunaSearch | SearchParamsError {
  // Country: must be one of our supported codes (compared in lower case). Empty
  // means "not chosen" and falls back to Australia, as the endpoint always has.
  const rawCountry = searchParams.get("country");
  let country = "au";
  if (rawCountry) {
    const known = ADZUNA_COUNTRIES.find((c) => c.code === rawCountry.toLowerCase());
    if (!known) return refuse("That country isn't supported for job search.");
    country = known.code; // from our own list, not from the request
  }

  const page = cleanPage(searchParams.get("page"));
  if (!page.ok) return page;

  const what = cleanText(searchParams.get("what"), "keywords", LIMITS.search.text);
  if (!what.ok) return what;

  const where = cleanText(searchParams.get("where"), "city", LIMITS.search.text);
  if (!where.ok) return where;

  // "date" surfaces newer, more varied roles; "" is the same as "relevance".
  const rawSort = searchParams.get("sort");
  if (rawSort !== null && rawSort !== "" && rawSort !== "relevance" && rawSort !== "date") {
    return refuse('The sort order must be "relevance" or "date".');
  }

  return {
    ok: true,
    country,
    page: page.page,
    what: what.value,
    where: where.value,
    sort: rawSort === "date" ? "date" : "relevance",
  };
}

/** Check the query string of GET /api/jooble. */
export function parseJoobleSearch(
  searchParams: URLSearchParams,
): JoobleSearch | SearchParamsError {
  // Location: the search page only ever offers "All Gulf" or one Gulf country, so
  // anything else is refused rather than forwarded to Jooble.
  const rawLocation = searchParams.get("location")?.trim() ?? "";
  let location: string | undefined;
  if (rawLocation === ALL_GULF) {
    location = ALL_GULF;
  } else {
    location = GULF_LOCATIONS.find((g) => g.location === rawLocation)?.location;
  }
  if (location === undefined) {
    return refuse("Choose a Gulf country to search.");
  }

  const page = cleanPage(searchParams.get("page"));
  if (!page.ok) return page;

  const what = cleanText(searchParams.get("what"), "keywords", JOOBLE_KEYWORD_LIMIT);
  if (!what.ok) return what;

  return { ok: true, what: what.value, location, page: page.page };
}
