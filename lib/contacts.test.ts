import { describe, expect, it } from "vitest";
import {
  cleanCapturedNotes,
  extractContacts,
  nameFromEmail,
  nameNear,
  splitStoredContacts,
} from "./contacts";

describe("extractContacts", () => {
  it("finds an email and a phone, deriving a name from the email address", () => {
    const { emails, phones } = extractContacts(
      "Email: jordan@meridiantalent.example\nPhone: 0491 570 156",
    );
    expect(emails).toEqual([{ value: "jordan@meridiantalent.example", name: "Jordan" }]);
    expect(phones).toEqual([{ value: "0491 570 156", name: "" }]);
  });

  it("attributes both contacts to a person named right next to them", () => {
    const { emails, phones } = extractContacts(
      "For a confidential discussion, contact Jordan Blake on 0491 570 156 or email jordan@meridiantalent.example. General enquiries: careers@meridiantalent.example.",
    );
    expect(phones[0]).toEqual({ value: "0491 570 156", name: "Jordan Blake" });
    expect(emails[0]).toEqual({
      value: "jordan@meridiantalent.example",
      name: "Jordan Blake",
    });
    // A role address is never given a person's name.
    expect(emails[1]).toEqual({ value: "careers@meridiantalent.example", name: "" });
  });

  it("does not mistake ordinary capitalised words for names", () => {
    const { phones } = extractContacts("We need Call Center staff, ring 0509998888");
    expect(phones).toEqual([{ value: "0509998888", name: "" }]);
  });

  it("does not mistake salaries, reference numbers or counts for phone numbers", () => {
    const { phones } = extractContacts(
      "Ref #12345. Budget 100000. Salary 140000-155000 AUD. 51 applicants. Posted 2 days ago.",
    );
    expect(phones).toEqual([]);
  });

  it("accepts international numbers and rejects ones with too few digits", () => {
    const { phones } = extractContacts("Call +971 50 123 4567 or 12 345");
    expect(phones.map((p) => p.value)).toEqual(["+971 50 123 4567"]);
  });

  it("de-duplicates repeated contacts", () => {
    const { emails } = extractContacts("Write to a.b@co.com or a.b@co.com again");
    expect(emails).toHaveLength(1);
  });

  it("returns nothing for empty text", () => {
    expect(extractContacts("")).toEqual({ emails: [], phones: [] });
  });
});

describe("nameNear / nameFromEmail", () => {
  it("looks both before and after a contact for a trigger plus name", () => {
    expect(nameNear("reach out to Sarah at sarah@x.com", "sarah@x.com")).toBe("Sarah");
    expect(nameNear("0400 000 000 (ask for Maria Lopez)", "0400 000 000")).toBe(
      "Maria Lopez",
    );
  });

  it("returns empty when the value is not in the text", () => {
    expect(nameNear("nothing here", "a@b.com")).toBe("");
  });

  it("builds names from email local parts", () => {
    expect(nameFromEmail("sarah.jones@company.com")).toBe("Sarah Jones");
    expect(nameFromEmail("hr@company.com")).toBe("");
    expect(nameFromEmail("recruitment@company.com")).toBe("");
    expect(nameFromEmail("a1b2c3@company.com")).toBe("");
  });
});

describe("cleanCapturedNotes", () => {
  it("strips LinkedIn's trailing '... more' toggle", () => {
    expect(cleanCapturedNotes("Great role.\n… more")).toBe("Great role.");
    expect(cleanCapturedNotes("Great role. ...more")).toBe("Great role.");
  });

  it("leaves ordinary text that merely ends in the word 'more'", () => {
    expect(cleanCapturedNotes("We want to learn more")).toBe("We want to learn more");
  });
});

describe("splitStoredContacts", () => {
  it("splits stored contacts into email and phone chips", () => {
    const split = splitStoredContacts([
      { type: "email", value: "a@b.com", name: "Ann", role: "Recruiter" },
      { type: "phone", value: "0400 000 000", name: "", role: "" },
    ]);
    expect(split.emails).toEqual([{ value: "a@b.com", name: "Ann" }]);
    expect(split.phones).toEqual([{ value: "0400 000 000", name: "" }]);
  });
});
