// lib/demo.ts
// Sample data for demo mode (open the app with ?demo=1). Lets a visitor try the
// whole product without signing in: nothing is saved, no accounts, no AI spend.
// Every company, person, email and phone number below is fictional (example.com
// style domains, numbers from Australia's reserved fictional ranges).

import type { Job } from "./jobs";
import type { CvMeta } from "./cvs";
import type { StoredAnalysis } from "./ai/schemas";

export const DEMO_CV_ID = "demo-cv-1";

export const DEMO_CVS: CvMeta[] = [
  { id: DEMO_CV_ID, name: "Alex-Morgan-CV-Product.pdf", role: "tech" },
  { id: "demo-cv-2", name: "Alex-Morgan-CV-Strategy.pdf", role: "strategy" },
];

const DAY = 86_400_000;

/** The sample board, with deadlines relative to `now` so the badges always show
 *  a realistic mix of overdue / due soon / later. */
export function buildDemoJobs(now: Date): Job[] {
  const iso = (offsetDays: number) =>
    new Date(now.getTime() + offsetDays * DAY).toISOString().slice(0, 10);
  const added = (daysAgo: number) =>
    new Date(now.getTime() - daysAgo * DAY).toISOString();

  const northwindDescription = [
    "About the job",
    "Northwind Labs is hiring a Senior Product Manager to own our self-serve onboarding experience.",
    "You will run discovery with customers, partner with design and engineering, and set the roadmap using usage data.",
    "Requirements: 4+ years in product management, experience running A/B tests, strong stakeholder communication, SQL for self-serve analysis, and some exposure to paid growth.",
    "To apply, contact Priya Nair on 0491 570 156 or email priya.nair@northwind.example.",
  ].join("\n");

  return [
    {
      id: "demo-1",
      title: "Senior Product Manager",
      company: "Northwind Labs",
      country: "Australia",
      url: "https://example.com/jobs/northwind-senior-pm",
      salary: "A$150,000–170,000 / yr",
      status: "interview",
      notes: northwindDescription,
      dateAdded: added(6),
      deadline: iso(9),
      followUpDate: iso(2),
      cvId: DEMO_CV_ID,
      contacts: [
        {
          type: "email",
          value: "priya.nair@northwind.example",
          name: "Priya Nair",
          role: "Hiring manager",
        },
        {
          type: "phone",
          value: "0491 570 156",
          name: "Priya Nair",
          role: "Hiring manager",
        },
      ],
    },
    {
      id: "demo-2",
      title: "Product Analyst",
      company: "Halcyon Health",
      country: "Singapore",
      url: "https://example.com/jobs/halcyon-product-analyst",
      salary: "S$7,500 / month",
      status: "applied",
      notes:
        "Product analytics role on the patient-app team. SQL, dashboards, experimentation. Applied via the company site.",
      dateAdded: added(11),
      followUpDate: iso(-1),
      cvId: DEMO_CV_ID,
    },
    {
      id: "demo-3",
      title: "Business Analyst",
      company: "Dune & Co",
      country: "United Arab Emirates",
      url: "https://example.com/jobs/dune-business-analyst",
      salary: "AED 22,000 / month",
      status: "interested",
      notes:
        "Business analyst for a regional retail group. Reporting, process mapping, stakeholder workshops. Send CVs to careers@dune.example.",
      dateAdded: added(2),
      deadline: iso(20),
    },
    {
      id: "demo-4",
      title: "Data Analyst",
      company: "Tern Logistics",
      country: "Netherlands",
      url: "https://example.com/jobs/tern-data-analyst",
      salary: "€4,800 / month",
      status: "interested",
      notes:
        "Data analyst supporting route-planning teams. Python or SQL, strong communication, hybrid in Rotterdam.",
      dateAdded: added(1),
    },
    {
      id: "demo-5",
      title: "Associate Product Manager",
      company: "Lumen Pay",
      country: "United Kingdom",
      url: "https://example.com/jobs/lumen-apm",
      salary: "£62,000 / yr",
      status: "offer",
      notes:
        "Associate PM on the payments team. Verbal offer received; written offer expected this week.",
      dateAdded: added(21),
      deadline: iso(4),
      cvId: "demo-cv-2",
    },
    {
      id: "demo-6",
      title: "Strategy Associate",
      company: "Orchard & Vale",
      country: "Qatar",
      url: "https://example.com/jobs/orchard-strategy-associate",
      salary: "",
      status: "rejected",
      notes: "Strategy associate for an advisory boutique. Rejected after the case interview.",
      dateAdded: added(34),
    },
  ];
}

/** The canned analysis shown in demo mode (no AI call is made). */
export function demoAnalysis(now: Date = new Date()): StoredAnalysis {
  return {
    fit_score: 78,
    verdict:
      "Strong on customer discovery and stakeholder work; thinner on the paid-growth exposure the role lists, which is worth addressing head-on.",
    strengths: [
      {
        point:
          "You have run structured discovery with customers and turned it into roadmap decisions.",
        job_requirement: "Run discovery with customers and set the roadmap",
        cv_evidence:
          "Ran 30+ customer interviews to reshape the onboarding flow, cutting drop-off at sign-up",
      },
      {
        point: "You have owned experiments end to end, not just analysed them.",
        job_requirement: "Experience running A/B tests",
        cv_evidence:
          "Designed and shipped 12 A/B tests across onboarding and pricing pages",
      },
      {
        point: "You work with SQL directly rather than waiting on analysts.",
        job_requirement: "SQL for self-serve analysis",
        cv_evidence:
          "Built weekly funnel dashboards in SQL for the leadership team",
      },
    ],
    gaps: [
      {
        requirement: "Exposure to paid growth",
        note: "Nothing in the CV mentions paid acquisition. If you have worked with a growth team on landing pages or attribution, add it; otherwise say plainly that you have partnered with marketing and are keen to go deeper.",
      },
      {
        requirement: "4+ years in product management",
        note: "The CV shows roughly three years in product roles. Lead with scope and outcomes rather than tenure.",
      },
    ],
    tailored_bullets: [
      {
        bullet:
          "Led customer discovery (30+ interviews) to redesign onboarding, reducing sign-up drop-off.",
        cv_evidence:
          "Ran 30+ customer interviews to reshape the onboarding flow, cutting drop-off at sign-up",
      },
      {
        bullet:
          "Owned a 12-test experimentation programme across onboarding and pricing, from hypothesis to rollout.",
        cv_evidence:
          "Designed and shipped 12 A/B tests across onboarding and pricing pages",
      },
    ],
    outreach: {
      email_subject: "Senior Product Manager, onboarding — quick note from Alex Morgan",
      email_body:
        "Hi Priya,\n\nI saw the Senior Product Manager role at Northwind Labs and wanted to reach out directly rather than just apply online. I have spent the last few years on onboarding: I ran 30+ customer interviews to rework our sign-up flow and shipped 12 A/B tests across onboarding and pricing, which is close to what you describe.\n\nI have partnered with marketing but not owned paid growth, and I would be keen to hear how that fits the role. Would you be open to a short call this week?\n\nBest,\nAlex Morgan",
      whatsapp_message:
        "Hi Priya, Alex Morgan here. I applied for the Senior PM role at Northwind. I have run onboarding discovery and 12 A/B tests, so it looks like a close fit. Happy to chat whenever suits you.",
    },
    generated_at: now.toISOString(),
    cv_id: DEMO_CV_ID,
    cv_name: "Alex-Morgan-CV-Product.pdf",
    model: "sample",
    removed_unverified: 0,
    confidence: "high",
    demo: true,
  };
}
