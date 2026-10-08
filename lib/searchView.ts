// lib/searchView.ts
// Works out what the search results panel should show once the "hide senior roles"
// filter is applied. Pure, so the paging arithmetic can be tested.
//
// Two kinds of results behave differently:
//   - pooled ("All Gulf"): the browser holds the whole merged list and pages through
//     it locally, so we filter the WHOLE pool first and paginate what is left. Every
//     page is then full of roles you want.
//   - server-paged (Adzuna, one Gulf country): the server returns one page at a time,
//     so we can only filter the page in hand. The total is the server's, unchanged,
//     and we report how many were hidden on this page.

import { isSeniorTitle } from "./seniority";

interface Titled {
  title: string;
}

export interface SearchView<T extends Titled> {
  /** The results to display on the current page. */
  items: T[];
  /** Total results the page-count is based on (after filtering, for pooled searches). */
  total: number;
  totalPages: number;
  /** How many results the filter hid. */
  hidden: number;
  /** Whether `hidden` covers every page ("all") or just the one in view ("page"). */
  hiddenScope: "all" | "page";
  /** Were there any results before filtering? (Distinguishes "no results" from "all hidden".) */
  hadResults: boolean;
}

export function buildSearchView<T extends Titled>(opts: {
  pooled: boolean;
  /** The whole merged list (pooled searches only). */
  pool: readonly T[];
  /** The current page as returned by the server (server-paged searches only). */
  pageResults: readonly T[];
  /** The server's reported total (server-paged searches only). */
  serverTotal: number;
  page: number; // 1-based
  pageSize: number;
  hideSenior: boolean;
}): SearchView<T> {
  const keep = (j: T) => !opts.hideSenior || !isSeniorTitle(j.title);

  if (opts.pooled) {
    const kept = opts.pool.filter(keep);
    const start = (opts.page - 1) * opts.pageSize;
    return {
      items: kept.slice(start, start + opts.pageSize),
      total: kept.length,
      totalPages: Math.max(1, Math.ceil(kept.length / opts.pageSize)),
      hidden: opts.pool.length - kept.length,
      hiddenScope: "all",
      hadResults: opts.pool.length > 0,
    };
  }

  const items = opts.pageResults.filter(keep);
  return {
    items,
    total: opts.serverTotal,
    totalPages: Math.max(1, Math.ceil(opts.serverTotal / opts.pageSize)),
    hidden: opts.pageResults.length - items.length,
    hiddenScope: "page",
    hadResults: opts.pageResults.length > 0,
  };
}
