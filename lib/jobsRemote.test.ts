import { describe, expect, it } from "vitest";
import { fromRow, toRow, type JobRow } from "./jobsRemote";
import { LIMITS } from "./limits";
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

describe("toRow keeps one bad job from wedging the batch upload", () => {
  const contact = (i: number) => ({
    type: "email" as const,
    value: `person${i}@example.com`,
    name: `Person ${i}`,
    role: "Recruiter",
  });

  it("cuts every text column to the database limit", () => {
    const row = toRow(
      {
        ...baseJob,
        title: "t".repeat(5_000),
        company: "c".repeat(5_000),
        country: "y".repeat(5_000),
        url: "u".repeat(50_000),
        salary: "s".repeat(5_000),
        notes: "n".repeat(500_000),
        deadline: "d".repeat(500),
        followUpDate: "f".repeat(500),
        cvId: "v".repeat(500),
      },
      "user-1",
    );
    expect(row.title).toHaveLength(LIMITS.job.title);
    expect(row.company).toHaveLength(LIMITS.job.company);
    expect(row.country).toHaveLength(LIMITS.job.country);
    expect(row.url).toHaveLength(LIMITS.job.url);
    expect(row.salary).toHaveLength(LIMITS.job.salary);
    expect(row.notes).toHaveLength(LIMITS.job.notes);
    expect(row.deadline).toHaveLength(LIMITS.job.date);
    expect(row.follow_up_date).toHaveLength(LIMITS.job.date);
    expect(row.cv_id).toHaveLength(LIMITS.job.cvId);
  });

  it("changes nothing for a job that is within the limits", () => {
    const job: Job = {
      ...baseJob,
      notes: "n".repeat(LIMITS.job.notes),
      deadline: "2026-10-20",
      contacts: [contact(1), contact(2)],
    };
    const row = toRow(job, "user-1");
    expect(row.notes).toBe(job.notes);
    expect(row.deadline).toBe("2026-10-20");
    expect(row.contacts).toEqual(job.contacts);
  });

  it("sends as many contacts as fit instead of all of them", () => {
    const contacts = Array.from({ length: 500 }, (_, i) => contact(i));
    const row = toRow({ ...baseJob, contacts }, "user-1");
    const sent = row.contacts ?? [];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(contacts.length);
    expect(sent).toEqual(contacts.slice(0, sent.length));
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(LIMITS.job.contactsJson * 0.8);
  });

  it("leaves out a fit analysis that is too big rather than sending a broken one", () => {
    const analysis = {
      fit_score: 50,
      verdict: "v".repeat(LIMITS.job.analysisJson),
      strengths: [],
      gaps: [],
      tailored_bullets: [],
      outreach: { email_subject: "", email_body: "", whatsapp_message: "" },
      generated_at: "2026-10-01T00:00:00.000Z",
      cv_id: "cv1",
      cv_name: "CV.pdf",
      model: "test",
      removed_unverified: 0,
      confidence: "high" as const,
    };
    expect(toRow({ ...baseJob, analysis }, "user-1")).not.toHaveProperty("analysis");
  });

  it("does not change the job in the app, only the row that is sent", () => {
    const job: Job = { ...baseJob, notes: "n".repeat(50_000) };
    toRow(job, "user-1");
    expect(job.notes).toHaveLength(50_000);
  });

  it("round-trips a trimmed job back to the same trimmed job", () => {
    const original: Job = { ...baseJob, notes: "n".repeat(50_000), cvId: "cv1" };
    const { user_id: _user, updated_at: _updated, ...columns } = toRow(original, "u");
    void _user;
    void _updated;
    expect(fromRow(columns as JobRow)).toEqual({
      ...original,
      notes: "n".repeat(LIMITS.job.notes),
    });
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
