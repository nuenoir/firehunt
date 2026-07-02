// lib/prep.ts
// Pure helper that turns a few details about a role into a ready-to-paste
// interview-prep prompt. No AI call here — the user pastes the prompt into
// their own (free) Claude/ChatGPT and pastes the answer back into Insights.

export interface PrepInput {
  role: string;
  company: string;
  location: string;
  seniority: string;
  jobDescription: string;
}

export function buildPrepPrompt(input: PrepInput): string {
  const { role, company, location, seniority, jobDescription } = input;
  const lines: string[] = [];

  lines.push(
    "You are an experienced interview coach. Help me prepare for a job interview.",
  );
  lines.push("");
  lines.push("Role details:");
  lines.push(`- Position: ${role.trim() || "(not specified)"}`);
  if (company.trim()) lines.push(`- Company: ${company.trim()}`);
  if (location.trim()) lines.push(`- Location: ${location.trim()}`);
  if (seniority.trim()) lines.push(`- Level: ${seniority.trim()}`);

  if (jobDescription.trim()) {
    lines.push("");
    lines.push("Job description:");
    lines.push('"""');
    lines.push(jobDescription.trim());
    lines.push('"""');
  }

  lines.push("");
  lines.push("Please give me:");
  lines.push(
    "1. How the interview process likely goes (rounds, formats, who I meet, rough timeline).",
  );
  lines.push(
    "2. The 10 most likely interview questions, each with a one-line tip on what a strong answer covers.",
  );
  lines.push(
    "3. What it takes to succeed in this role — the skills, qualities, and signals they reward.",
  );
  lines.push(
    "4. Common red flags or mistakes candidates make, and how to avoid them.",
  );
  lines.push("5. Three sharp questions I can ask the interviewer to stand out.");
  lines.push("");
  lines.push(
    "Keep it specific and practical. If you are not sure about this exact company, say so clearly and give general guidance for this kind of role and region instead of guessing.",
  );

  return lines.join("\n");
}
