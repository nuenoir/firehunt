import { describe, expect, it } from "vitest";
import { buildSearchView } from "./searchView";

const mk = (title: string) => ({ title });
const SENIOR = ["Senior Analyst", "Director of X", "Head of Y", "Principal Z", "VP Sales"];
const MID = ["Analyst", "Coordinator", "Associate PM", "Business Analyst", "Product Manager"];

describe("buildSearchView — pooled (All Gulf)", () => {
  // 25 mid-level and 25 senior roles, interleaved.
  const pool = Array.from({ length: 50 }, (_, i) =>
    mk(i % 2 === 0 ? `${MID[(i / 2) % 5]} ${i}` : `${SENIOR[((i - 1) / 2) % 5]} ${i}`),
  );

  it("returns every result when the filter is off", () => {
    const v = buildSearchView({ pooled: true, pool, pageResults: [], serverTotal: 0, page: 1, pageSize: 30, hideSenior: false });
    expect(v.total).toBe(50);
    expect(v.totalPages).toBe(2);
    expect(v.items).toHaveLength(30);
    expect(v.hidden).toBe(0);
  });

  it("filters the WHOLE pool and then paginates what is left", () => {
    const v1 = buildSearchView({ pooled: true, pool, pageResults: [], serverTotal: 0, page: 1, pageSize: 10, hideSenior: true });
    expect(v1.total).toBe(25);
    expect(v1.totalPages).toBe(3);
    expect(v1.items).toHaveLength(10); // a FULL page, not a thinned-out one
    expect(v1.hidden).toBe(25);
    expect(v1.hiddenScope).toBe("all");

    const v3 = buildSearchView({ pooled: true, pool, pageResults: [], serverTotal: 0, page: 3, pageSize: 10, hideSenior: true });
    expect(v3.items).toHaveLength(5);
    // Nothing senior anywhere on any page.
    const all = [1, 2, 3].flatMap((p) =>
      buildSearchView({ pooled: true, pool, pageResults: [], serverTotal: 0, page: p, pageSize: 10, hideSenior: true }).items,
    );
    expect(all.some((j) => SENIOR.some((s) => j.title.startsWith(s)))).toBe(false);
  });

  it("is never fewer than one page, even when everything is hidden", () => {
    const allSenior = SENIOR.map(mk);
    const v = buildSearchView({ pooled: true, pool: allSenior, pageResults: [], serverTotal: 0, page: 1, pageSize: 30, hideSenior: true });
    expect(v.items).toEqual([]);
    expect(v.totalPages).toBe(1);
    expect(v.hadResults).toBe(true); // "all hidden", not "no results"
    expect(v.hidden).toBe(5);
  });

  it("reports no results for an empty pool", () => {
    const v = buildSearchView({ pooled: true, pool: [], pageResults: [], serverTotal: 0, page: 1, pageSize: 30, hideSenior: true });
    expect(v.hadResults).toBe(false);
  });
});

describe("buildSearchView — server-paged (Adzuna / one country)", () => {
  const pageResults = [...MID, ...SENIOR].map(mk);

  it("filters only the page in hand and keeps the server's total", () => {
    const v = buildSearchView({ pooled: false, pool: [], pageResults, serverTotal: 4514, page: 2, pageSize: 30, hideSenior: true });
    expect(v.items.map((j) => j.title)).toEqual(MID);
    expect(v.total).toBe(4514);
    expect(v.totalPages).toBe(Math.ceil(4514 / 30));
    expect(v.hidden).toBe(5);
    expect(v.hiddenScope).toBe("page");
  });

  it("changes nothing when the filter is off", () => {
    const v = buildSearchView({ pooled: false, pool: [], pageResults, serverTotal: 10, page: 1, pageSize: 30, hideSenior: false });
    expect(v.items).toHaveLength(10);
    expect(v.hidden).toBe(0);
  });

  it("tells 'all hidden on this page' apart from 'no results'", () => {
    const hiddenAll = buildSearchView({ pooled: false, pool: [], pageResults: SENIOR.map(mk), serverTotal: 99, page: 1, pageSize: 30, hideSenior: true });
    expect(hiddenAll.items).toEqual([]);
    expect(hiddenAll.hadResults).toBe(true);
    const none = buildSearchView({ pooled: false, pool: [], pageResults: [], serverTotal: 0, page: 1, pageSize: 30, hideSenior: true });
    expect(none.hadResults).toBe(false);
  });
});
