import { describe, expect, it } from "vitest";
import { isSeniorTitle } from "./seniority";

describe("isSeniorTitle", () => {
  // Real titles from the search results that prompted this feature.
  it.each([
    ["Director, Product Management (Pricing & Assurance)", true],
    ["Director, Product Management - Corporate Solutions", true],
    ["Principal Product Manager - Verification & Activation(Exchange)", true],
    ["Principal Product Manager - Discovery & Onboarding(Exchange)", true],
    ["Senior Product Manager, Trading(Crypto.com App)", true],
    ["Senior Manager, Product Marketing (Europe, EEA)", true],
    ["Senior Product Designer", true],
    ["Senior Compliance Manager", true],
    ["Deputy General Counsel", true],
    ["Product Integration, EEMEA", false],
    ["Product Growth Hacker (Exchange)", false],
    ["Associate Product Designer", false],
    ["Manager, CDD Operations", false],
    ["Machine Learning - Intern", false],
    ["Technical & AV Specialists", false],
  ])("%s -> senior: %s", (title, expected) => {
    expect(isSeniorTitle(title)).toBe(expected);
  });

  it("recognises leadership and executive titles", () => {
    for (const t of [
      "Head of Product",
      "VP of Engineering",
      "Vice President, Finance",
      "SVP Sales",
      "AVP, Risk",
      "Chief of Staff",
      "Chief Product Officer",
      "CEO",
      "CFO - Gulf Region",
      "Managing Director",
      "Associate Director, Strategy",
      "General Manager, Retail",
      "Country Manager UAE",
      "Tech Lead",
      "Team Lead - Support",
      "Staff Software Engineer",
      "Sr. Data Analyst",
      "Sr Data Analyst",
      "President, Middle East",
    ]) {
      expect(isSeniorTitle(t), t).toBe(true);
    }
  });

  it("does not hide common mid-level titles", () => {
    for (const t of [
      "Product Manager",
      "Product Analyst",
      "Business Analyst",
      "Data Analyst",
      "Account Executive",
      "Sales Executive",
      "Executive Assistant",
      "Associate Product Manager",
      "Project Manager - ServiceNow",
      "Junior Analyst",
      "Marketing Coordinator",
      "Strategy Associate",
      "Management Consultant",
    ]) {
      expect(isSeniorTitle(t), t).toBe(false);
    }
  });

  it("avoids known false positives", () => {
    expect(isSeniorTitle("Lead Generation Specialist")).toBe(false);
    expect(isSeniorTitle("Staff Nurse")).toBe(false);
    expect(isSeniorTitle("Seniority and Compensation Analyst")).toBe(false);
    expect(isSeniorTitle("Directory Services Administrator")).toBe(false);
    expect(isSeniorTitle("CRO Analyst")).toBe(false); // conversion-rate optimisation, not a chief
    expect(isSeniorTitle("CTO")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSeniorTitle("SENIOR ANALYST")).toBe(true);
    expect(isSeniorTitle("head OF design")).toBe(true);
  });
});
