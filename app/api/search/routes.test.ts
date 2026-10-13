// Route-level tests for the two PUBLIC search endpoints (/api/adzuna, /api/jooble).
//
// What they prove: a hostile or malformed request is refused with a 400 BEFORE
// anything else happens - the upstream API (which would carry our secret key) is
// never called and the rate-limit database is never touched - while a request like
// the ones the search page really sends still reaches the (mocked) upstream with
// exactly the right URL / body. The Supabase admin client is faked, but the real
// rate limiter and the real validators run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GULF_LOCATIONS } from "@/lib/jooble";
import { LIMITS } from "@/lib/limits";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getAdminClient: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/server/admin", () => ({ getAdminClient: mocks.getAdminClient }));

import { GET as adzuna } from "../adzuna/route";
import { GET as jooble } from "../jooble/route";

const APP_ID = "test-app-id";
const APP_KEY = "test-app-key";
const JOOBLE_KEY = "test-jooble-key";

/** A request from a (fictional, documentation-range) visitor. */
const call = (path: string, query: string | Record<string, string> = {}) =>
  new Request(`https://x.test${path}?${new URLSearchParams(query).toString()}`, {
    headers: { "x-forwarded-for": "203.0.113.7" },
  });

const adzunaCall = (query?: string | Record<string, string>) => call("/api/adzuna", query);
const joobleCall = (query?: string | Record<string, string>) => call("/api/jooble", query);

/** The URL the route handed to fetch() for its n-th upstream call. */
function upstreamUrl(n = 0): URL {
  const arg = mocks.fetch.mock.calls[n][0];
  return arg instanceof URL ? arg : new URL(String(arg));
}

/** The rate-limit keys that were counted, in order. */
const countedKeys = () =>
  mocks.rpc.mock.calls.map((c) => (c[1] as { p_key: string }).p_key);

/** One fictional Adzuna job, as the upstream API returns it. */
const adzunaApiJob = {
  id: "a1",
  title: "Data Analyst",
  company: { display_name: "Fictional Analytics Ltd" },
  location: { display_name: "London" },
  redirect_url: "https://jobs.example/a1",
  salary_min: 50000,
  salary_max: 60000,
  description: "Analyse   the\n numbers",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.getAdminClient.mockReturnValue({ rpc: mocks.rpc });
  mocks.fetch.mockImplementation(async () => Response.json({ count: 1, results: [adzunaApiJob] }));
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("ADZUNA_APP_ID", APP_ID);
  vi.stubEnv("ADZUNA_APP_KEY", APP_KEY);
  vi.stubEnv("JOOBLE_API_KEY", JOOBLE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Assert the request was refused up front: 400, nothing upstream, no database call. */
async function expectRejectedUpFront(res: Response) {
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(10);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.getAdminClient).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
}

/** A short label for a test row (some attack strings are thousands of characters). */
const show = (q: string | Record<string, string>) => {
  const text = new URLSearchParams(q).toString();
  return text.length > 60 ? `${text.slice(0, 40)}...(${text.length} chars)` : text;
};

describe("GET /api/adzuna: valid requests", () => {
  it("sends the validated values to Adzuna and maps the results as before", async () => {
    const res = await adzuna(
      adzunaCall({ country: "gb", what: "data analyst", where: "London", page: "3", sort: "date" }),
    );
    expect(res.status).toBe(200);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const url = upstreamUrl();
    expect(url.origin).toBe("https://api.adzuna.com");
    expect(url.pathname).toBe("/v1/api/jobs/gb/search/3");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_id: APP_ID,
      app_key: APP_KEY,
      results_per_page: "30",
      "content-type": "application/json",
      what: "data analyst",
      where: "London",
      sort_by: "date",
    });
    expect(mocks.fetch.mock.calls[0][1]).toEqual({ cache: "no-store" });

    expect(await res.json()).toEqual({
      count: 1,
      results: [
        {
          externalId: "a1",
          title: "Data Analyst",
          company: "Fictional Analytics Ltd",
          location: "London",
          url: "https://jobs.example/a1",
          salary: "£50,000–£60,000 / yr",
          description: "Analyse the numbers",
        },
      ],
    });
  });

  it("uses Australia, page 1 and no filters when nothing is given (as it always has)", async () => {
    expect((await adzuna(adzunaCall())).status).toBe(200);
    const url = upstreamUrl();
    expect(url.pathname).toBe("/v1/api/jobs/au/search/1");
    expect(url.searchParams.has("what")).toBe(false);
    expect(url.searchParams.has("where")).toBe(false);
    expect(url.searchParams.has("sort_by")).toBe(false);
  });

  it("does not ask Adzuna to sort when the page sends 'relevance'", async () => {
    await adzuna(adzunaCall({ country: "nl", sort: "relevance" }));
    expect(upstreamUrl().searchParams.has("sort_by")).toBe(false);
  });

  it("counts the visitor and the site-wide allowance exactly once each", async () => {
    await adzuna(adzunaCall({ country: "us" }));
    expect(countedKeys()).toEqual(["search:ip:203.0.113.7", "search:adzuna:site"]);
  });

  it("keeps odd-looking keywords as plain query text; they cannot add or replace parameters", async () => {
    const sneaky = "x&app_key=evil&app_id=evil#../?";
    await adzuna(adzunaCall({ country: "gb", what: sneaky, where: "../../etc" }));
    const url = upstreamUrl();
    expect(url.pathname).toBe("/v1/api/jobs/gb/search/1");
    expect(url.searchParams.getAll("app_key")).toEqual([APP_KEY]);
    expect(url.searchParams.getAll("app_id")).toEqual([APP_ID]);
    expect(url.searchParams.get("what")).toBe(sneaky);
    expect(url.searchParams.get("where")).toBe("../../etc");
  });

  it("still maps an upstream failure and a network failure to friendly errors", async () => {
    mocks.fetch.mockImplementationOnce(async () => new Response("nope", { status: 503 }));
    const failed = await adzuna(adzunaCall({ country: "gb" }));
    expect(failed.status).toBe(503);
    expect((await failed.json()).error).toMatch(/HTTP 503/);

    mocks.fetch.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    expect((await adzuna(adzunaCall({ country: "gb" }))).status).toBe(502);
  });

  it("is refused with 429 (and never reaches Adzuna) when the visitor is over their limit", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const res = await adzuna(adzunaCall({ country: "gb" }));
    expect(res.status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("says so clearly when the Adzuna keys are not configured", async () => {
    vi.stubEnv("ADZUNA_APP_KEY", "");
    const res = await adzuna(adzunaCall({ country: "gb" }));
    expect(res.status).toBe(500);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/adzuna: hostile requests are stopped before any upstream or database work", () => {
  const attacks: Array<string | Record<string, string>> = [
    // Country steering the upstream path.
    { country: "../../x" },
    { country: "gb/../../jobs" },
    { country: "gb%2f.." }, // arrives as the literal text "gb%2f.."
    { country: "gb?app_key=evil" },
    { country: "gb#x" },
    { country: "/gb" },
    { country: " gb" },
    { country: "__proto__" },
    { country: "xx" },
    { country: "a".repeat(5000) },
    "country=..%2F..%2Fx", // arrives decoded as "../../x"
    "country=gb%2f..", // arrives decoded as "gb/.."
    // Page steering the upstream path or exploding the page depth.
    { page: "1/../../../x" },
    { page: "-1" },
    { page: "0" },
    { page: "1.5" },
    { page: "1e3" },
    { page: "99999999999999999999" },
    { page: " 2" },
    { page: "" },
    { page: String(LIMITS.search.maxPage + 1) },
    "page=1%2F..%2F..",
    // Oversize or unprintable text.
    { what: "x".repeat(5000) },
    { what: "x".repeat(LIMITS.search.text + 1) },
    { where: "c".repeat(LIMITS.search.text + 1) },
    { what: "a\0b" },
    { where: "a\u0007b" },
    "what=a%00b",
    // Unknown sort.
    { sort: "evil" },
    { sort: "DATE" },
  ];

  it.each(attacks.map((a) => [show(a), a] as const))("%s", async (_label, query) => {
    await expectRejectedUpFront(await adzuna(adzunaCall(query)));
  });

  it("checks the request before the rate limiter, so a refused visitor still hears about the real problem", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const res = await adzuna(adzunaCall({ country: "../../x" }));
    expect(res.status).toBe(400);
  });

  it("checks the request before the server's own configuration", async () => {
    vi.stubEnv("ADZUNA_APP_ID", "");
    expect((await adzuna(adzunaCall({ page: "0" }))).status).toBe(400);
  });
});

describe("GET /api/jooble: valid requests", () => {
  const joobleApiJob = {
    id: 7,
    title: "Site Engineer",
    company: " Fictional Builders ",
    location: "Doha",
    salary: "",
    snippet: "<b>Build</b>  things",
    link: "https://jobs.example/j7",
  };

  beforeEach(() => {
    mocks.fetch.mockImplementation(async () =>
      Response.json({ totalCount: 41, jobs: [joobleApiJob] }),
    );
  });

  it("sends one validated search to Jooble and maps the results as before", async () => {
    const res = await jooble(joobleCall({ what: "engineer Doha", location: "Qatar", page: "2" }));
    expect(res.status).toBe(200);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [target, init] = mocks.fetch.mock.calls[0];
    expect(String(target)).toBe(`https://jooble.org/api/${JOOBLE_KEY}`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ keywords: "engineer Doha", location: "Qatar", page: "2" });

    expect(await res.json()).toEqual({
      count: 41,
      results: [
        {
          externalId: "7",
          title: "Site Engineer",
          company: "Fictional Builders",
          location: "Doha",
          url: "https://jobs.example/j7",
          salary: "",
          description: "Build things",
        },
      ],
    });
    expect(countedKeys()).toEqual(["search:ip:203.0.113.7", "search:jooble:site"]);
  });

  it("defaults to page 1 and no keywords", async () => {
    await jooble(joobleCall({ location: "Oman" }));
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({
      keywords: "",
      location: "Oman",
      page: "1",
    });
  });

  it("'All Gulf' asks Jooble about every Gulf country, merges without duplicates, and counts six site-wide hits", async () => {
    mocks.fetch.mockImplementation(async (_target: unknown, init: { body: string }) => {
      const { location } = JSON.parse(init.body) as { location: string };
      return Response.json({
        totalCount: 2,
        jobs: [
          { id: `own-${location}`, title: "Own", link: `https://jobs.example/${encodeURIComponent(location)}` },
          { id: "shared", title: "Shared", link: "https://jobs.example/shared" },
        ],
      });
    });

    const res = await jooble(joobleCall({ what: "nurse", location: "ALL_GULF" }));
    expect(res.status).toBe(200);

    expect(mocks.fetch).toHaveBeenCalledTimes(GULF_LOCATIONS.length);
    const asked = mocks.fetch.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(asked.map((b) => b.location)).toEqual(GULF_LOCATIONS.map((g) => g.location));
    expect(asked.every((b) => b.keywords === "nurse" && b.page === "1")).toBe(true);

    const body = await res.json();
    expect(body.pooled).toBe(true);
    expect(body.count).toBe(GULF_LOCATIONS.length + 1); // six own jobs + the shared one, once
    expect(countedKeys().filter((k) => k === "search:jooble:site")).toHaveLength(GULF_LOCATIONS.length);
  });

  it("allows the longest search the page can build (keywords + space + city)", async () => {
    const folded = `${"a".repeat(LIMITS.search.text)} ${"b".repeat(LIMITS.search.text)}`;
    const res = await jooble(joobleCall({ what: folded, location: "Qatar" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).keywords).toBe(folded);
  });

  it("maps a network failure to a friendly 502", async () => {
    mocks.fetch.mockImplementation(async () => {
      throw new Error("network down");
    });
    expect((await jooble(joobleCall({ location: "Qatar" }))).status).toBe(502);
  });

  it("is refused with 429 (and never reaches Jooble) when the site-wide allowance is gone", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await jooble(joobleCall({ location: "Qatar" }))).status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/jooble: hostile requests are stopped before any upstream or database work", () => {
  const attacks: Array<string | Record<string, string>> = [
    {}, // no location at all
    { location: "" },
    { location: "Narnia" },
    { location: "qatar" },
    { location: "all_gulf" },
    { location: "ALL_GULF/../x" },
    { location: "Qatar,Kuwait" },
    { location: "Qatar\0" },
    { location: "Q".repeat(5000) },
    { location: "Qatar", page: "1/../../x" },
    { location: "Qatar", page: "-1" },
    { location: "Qatar", page: "0" },
    { location: "Qatar", page: "1.5" },
    { location: "Qatar", page: "1e3" },
    { location: "Qatar", page: "99999999999999999999" },
    { location: "Qatar", page: " 2" },
    { location: "Qatar", page: "" },
    { location: "ALL_GULF", page: String(LIMITS.search.maxPage + 1) },
    { location: "Qatar", what: "x".repeat(5000) },
    { location: "ALL_GULF", what: "x".repeat(5000) },
    { location: "Qatar", what: "a\0b" },
    "location=Qatar&what=a%00b",
  ];

  it.each(attacks.map((a) => [show(a), a] as const))("%s", async (_label, query) => {
    await expectRejectedUpFront(await jooble(joobleCall(query)));
  });

  it("does not let an invalid 'All Gulf' request burn six site-wide allowances", async () => {
    await jooble(joobleCall({ location: "ALL_GULF", page: "0" }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("checks the request before the rate limiter and before the server's own configuration", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    vi.stubEnv("JOOBLE_API_KEY", "");
    expect((await jooble(joobleCall({ location: "Narnia" }))).status).toBe(400);
  });
});
