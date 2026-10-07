import { describe, expect, it } from "vitest";
import { fromRow, toRow, type JobRow } from "./jobsRemote";
import type { Job } from "./jobs";

const baseJob: Job = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Product Manager",
  company: "Acme",
  country: "Australia",
  url: "https://example.com/job",
  salary: "A$150k",
  status: "applied",
  notes: "notes",
  dateAdded: "2026-10-01T00:00:00.000Z",
};

describe("toRow", () => {
  it("maps camelCase fields to snake_case columns and tags the owner", () => {
    const row = toRow(
      { ...baseJob, deadline: "2026-10-20", followUpDate: "2026-10-10", cvId: "cv1" },
      "user-1",
    );
    expect(row).toMatchObject({
      id: baseJob.id,
      user_id: "user-1",
      date_added: baseJob.dateAdded,
      deadline: "2026-10-20",
      follow_up_date: "2026-10-10",
      cv_id: "cv1",
    });
  });

  it("writes null for dates and CV that are not set", () => {
    const row = toRow(baseJob, "user-1");
    expect(row.deadline).toBeNull();
    expect(row.follow_up_date).toBeNull();
    expect(row.cv_id).toBeNull();
  });

  it("omits the AI columns unless the job has AI data, so older databases still accept it", () => {
    const plain = toRow(baseJob, "user-1");
    expect(plain).not.toHaveProperty("contacts");
    expect(plain).not.toHaveProperty("analysis");

    const withAi = toRow(
      {
        ...baseJob,
        contacts: [{ type: "email", value: "a@b.com", name: "Ann", role: "" }],
      },
      "user-1",
    );
    expect(withAi).toHaveProperty("contacts");
    expect(withAi).not.toHaveProperty("analysis");
  });
});

describe("fromRow", () => {
  const row: JobRow = {
    id: baseJob.id,
    title: "Product Manager",
    company: "Acme",
    country: "Australia",
    url: "",
    salary: "",
    status: "interview",
    notes: "",
    date_added: "2026-10-01T00:00:00.000Z",
    deadline: null,
    follow_up_date: null,
    cv_id: null,
  };

  it("maps columns back and turns nulls into undefined", () => {
    const job = fromRow(row);
    expect(job.status).toBe("interview");
    expect(job.dateAdded).toBe("2026-10-01T00:00:00.000Z");
    expect(job.deadline).toBeUndefined();
    expect(job.cvId).toBeUndefined();
    expect(job.contacts).toBeUndefined();
    expect(job.analysis).toBeUndefined();
  });

  it("round-trips a job through the database shape", () => {
    const original: Job = {
      ...baseJob,
      deadline: "2026-10-20",
      followUpDate: "2026-10-10",
      cvId: "cv1",
      contacts: [{ type: "phone", value: "0400 000 000", name: "", role: "" }],
    };
    const { user_id: _user, updated_at: _updated, ...columns } = toRow(original, "u");
    void _user;
    void _updated;
    expect(fromRow(columns as JobRow)).toEqual(original);
  });
});
