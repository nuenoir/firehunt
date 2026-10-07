import { describe, expect, it } from "vitest";
import {
  dueStatus,
  filterJobs,
  jobStats,
  needsAttention,
  type Job,
} from "./jobs";

const job = (over: Partial<Job>): Job => ({
  id: "1",
  title: "Product Manager",
  company: "Acme",
  country: "Australia",
  url: "",
  salary: "",
  status: "interested",
  notes: "",
  dateAdded: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("dueStatus", () => {
  const today = "2026-10-07";
  it("classifies dates relative to today", () => {
    expect(dueStatus("2026-10-06", today)).toBe("overdue");
    expect(dueStatus("2026-10-07", today)).toBe("today");
    expect(dueStatus("2026-10-10", today)).toBe("soon"); // 3 days away
    expect(dueStatus("2026-10-11", today)).toBe("later"); // 4 days away
  });

  it("returns empty when there is no date or no reference date", () => {
    expect(dueStatus(undefined, today)).toBe("");
    expect(dueStatus("", today)).toBe("");
    expect(dueStatus("2026-10-10", "")).toBe("");
  });

  it("flags only urgent states as needing attention", () => {
    expect(needsAttention("overdue")).toBe(true);
    expect(needsAttention("today")).toBe(true);
    expect(needsAttention("soon")).toBe(true);
    expect(needsAttention("later")).toBe(false);
    expect(needsAttention("")).toBe(false);
  });
});

describe("jobStats", () => {
  it("counts stages and computes the response rate", () => {
    const stats = jobStats([
      job({ status: "interested" }),
      job({ status: "applied" }),
      job({ status: "applied" }),
      job({ status: "interview" }),
      job({ status: "offer" }),
      job({ status: "rejected" }),
    ]);
    expect(stats.total).toBe(6);
    expect(stats.byStatus).toEqual({
      interested: 1,
      applied: 2,
      interview: 1,
      offer: 1,
      rejected: 1,
    });
    expect(stats.appliedOrBeyond).toBe(5);
    expect(stats.responses).toBe(2);
    expect(stats.responseRate).toBeCloseTo(0.4);
  });

  it("does not divide by zero when nothing has been applied to", () => {
    expect(jobStats([]).responseRate).toBe(0);
    expect(jobStats([job({ status: "interested" })]).responseRate).toBe(0);
  });
});

describe("filterJobs", () => {
  const jobs = [
    job({ id: "a", title: "Data Analyst", company: "Northwind", country: "Australia" }),
    job({ id: "b", title: "Product Manager", company: "Halcyon", country: "Singapore" }),
  ];

  it("filters by country", () => {
    expect(filterJobs(jobs, { country: "Singapore", query: "" }).map((j) => j.id)).toEqual(["b"]);
  });

  it("filters by title or company, case-insensitively", () => {
    expect(filterJobs(jobs, { country: "", query: "NORTH" }).map((j) => j.id)).toEqual(["a"]);
    expect(filterJobs(jobs, { country: "", query: "manager" }).map((j) => j.id)).toEqual(["b"]);
  });

  it("returns everything with no filters", () => {
    expect(filterJobs(jobs, { country: "", query: "  " })).toHaveLength(2);
  });
});
