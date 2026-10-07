// Runs the REAL bookmarklet code against mock job pages and checks what it would
// send to FireHunt. This is how we know the parsing works on structured-data sites
// and on LinkedIn, which exposes almost nothing to scripts.

import { describe, expect, it } from "vitest";
import { buildBookmarklet } from "./bookmarklet";

const ORIGIN = "https://firehunt.vercel.app";

interface MockPage {
  title: string;
  jsonLd?: unknown[];
  metas?: Record<string, string>;
  bodyText?: string;
  selection?: string;
  url?: string;
}

/** Execute the bookmarklet against a mock page; return the params it would open. */
function runBookmarklet(page: MockPage) {
  const code = buildBookmarklet(ORIGIN).replace(/^javascript:/, "");
  let opened = "";
  const doc = {
    title: page.title,
    body: { innerText: page.bodyText ?? "" },
    querySelectorAll: (sel: string) =>
      sel.includes("ld+json")
        ? (page.jsonLd ?? []).map((j) => ({ textContent: JSON.stringify(j) }))
        : [],
    querySelector: (sel: string) => {
      const meta = /meta\[property="([^"]+)"\]/.exec(sel);
      if (meta && page.metas?.[meta[1]] !== undefined) {
        return { content: page.metas[meta[1]] };
      }
      return null;
    },
    createElement: () => {
      let html = "";
      return {
        set innerHTML(v: string) {
          html = v;
        },
        get textContent() {
          return html
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&");
        },
      };
    },
  };
  const win = {
    getSelection: () => page.selection ?? "",
    open: (url: string) => {
      opened = url;
    },
  };
  new Function("document", "window", "location", code)(doc, win, {
    href: page.url ?? "https://jobs.example.com/view/1",
  });
  const q = new URL(opened).searchParams;
  return {
    opened,
    title: q.get("fh_title"),
    company: q.get("fh_company"),
    url: q.get("fh_url"),
    salary: q.get("fh_salary"),
    notes: q.get("fh_notes") ?? "",
  };
}

describe("buildBookmarklet", () => {
  it("produces a javascript: URL that compiles and opens this FireHunt", () => {
    const code = buildBookmarklet(ORIGIN);
    expect(code.startsWith("javascript:(function(){")).toBe(true);
    expect(() => new Function(code.replace(/^javascript:/, ""))).not.toThrow();
    expect(code).toContain(JSON.stringify(ORIGIN));
  });
});

describe("bookmarklet on a site with JobPosting structured data", () => {
  const posting = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Product Owner",
    hiringOrganization: { "@type": "Organization", name: "Meridian Talent" },
    jobLocation: {
      "@type": "Place",
      address: {
        addressLocality: "Brisbane",
        addressRegion: "QLD",
        addressCountry: "AU",
      },
    },
    baseSalary: {
      currency: "AUD",
      value: { minValue: 140000, maxValue: 155000, unitText: "YEAR" },
    },
    description:
      "<p>We are hiring a <b>Product Owner</b>.</p><p>To apply, email careers@meridiantalent.example or call +971 50 123 4567.</p><ul><li>5+ years exp</li></ul>",
  };

  it("fills title, company, salary, location, description and contacts", () => {
    const r = runBookmarklet({ title: "ignored", jsonLd: [posting] });
    expect(r.title).toBe("Product Owner");
    expect(r.company).toBe("Meridian Talent");
    expect(r.salary).toBe("AUD 140000-155000 / year");
    expect(r.notes).toContain("Email: careers@meridiantalent.example");
    expect(r.notes).toContain("Phone: +971 50 123 4567");
    expect(r.notes).toContain("Location: Brisbane, QLD, AU");
    expect(r.notes).toContain("We are hiring a Product Owner.");
  });

  it("does not let a phone number swallow the next line (e.g. '5+ years')", () => {
    const r = runBookmarklet({ title: "x", jsonLd: [posting] });
    expect(r.notes).toMatch(/Phone: \+971 50 123 4567(\n|$)/);
    expect(r.notes).not.toMatch(/Phone: [^\n]*\n5\n/);
  });

  it("finds the posting inside an @graph wrapper", () => {
    const r = runBookmarklet({
      title: "x",
      jsonLd: [
        {
          "@graph": [
            { "@type": "WebPage" },
            {
              "@type": "JobPosting",
              title: "Data Analyst",
              hiringOrganization: "Acme Corp",
              baseSalary: { currency: "AED", value: { value: 30000, unitText: "MONTH" } },
              description: "Analyse data.",
            },
          ],
        },
      ],
    });
    expect(r.title).toBe("Data Analyst");
    expect(r.company).toBe("Acme Corp");
    expect(r.salary).toBe("AED 30000 / month");
  });

  it("survives malformed JSON-LD and falls back to the page title", () => {
    const code = buildBookmarklet(ORIGIN).replace(/^javascript:/, "");
    let opened = "";
    const doc = {
      title: "Fallback Title",
      body: { innerText: "" },
      querySelectorAll: () => [{ textContent: "{ not json" }],
      querySelector: () => null,
      createElement: () => ({ innerHTML: "", textContent: "" }),
    };
    new Function("document", "window", "location", code)(
      doc,
      { getSelection: () => "", open: (u: string) => (opened = u) },
      { href: "https://x.test/" },
    );
    expect(new URL(opened).searchParams.get("fh_title")).toBe("Fallback Title");
  });
});

describe("bookmarklet on LinkedIn (no structured data, no meta tags)", () => {
  const linkedinText = [
    "0 notifications",
    "Home",
    "Meridian Talent",
    "Product Owner",
    "51 applicants",
    "About the job",
    "We are hiring a Senior Mobile Product Owner, based in Brisbane.",
    "To apply, contact jordan@meridiantalent.example or call 0491 570 156.",
    "Meet the hiring team",
    "Similar jobs",
    "Product Manager",
    "Set alert",
  ].join("\n");

  it("recovers title and company from the tab title", () => {
    const r = runBookmarklet({
      title: "Product Owner | Meridian Talent | LinkedIn",
      bodyText: linkedinText,
    });
    expect(r.title).toBe("Product Owner");
    expect(r.company).toBe("Meridian Talent");
  });

  it("captures the visible 'About the job' text and drops the 'Similar jobs' noise", () => {
    const r = runBookmarklet({
      title: "Product Owner | Meridian Talent | LinkedIn",
      bodyText: linkedinText,
    });
    expect(r.notes).toContain("About the job");
    expect(r.notes).toContain("Senior Mobile Product Owner");
    expect(r.notes).not.toContain("Similar jobs");
    expect(r.notes).not.toContain("Set alert");
    expect(r.notes).toContain("Email: jordan@meridiantalent.example");
    expect(r.notes).toContain("Phone: 0491 570 156");
  });

  it("puts a user's highlighted text first when the page text is unavailable", () => {
    const r = runBookmarklet({
      title: "Product Owner | Acme | LinkedIn",
      selection: "Highlighted: email hiring@acme.example today",
    });
    expect(r.notes).toContain("Email: hiring@acme.example");
    expect(r.notes).toContain("Highlighted: email hiring@acme.example today");
  });

  it("does not use 'LinkedIn' as the company name", () => {
    const r = runBookmarklet({
      title: "Product Owner | LinkedIn",
      metas: { "og:site_name": "LinkedIn" },
    });
    expect(r.company).toBe("");
  });
});
