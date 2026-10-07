// FireHunt AI eval harness.
//
//   npm run eval            -> prints what it WOULD do and the estimated cost, then stops
//   npm run eval -- --yes   -> actually runs the cases against the real Claude API
//
// It calls the same service functions the app uses (lib/ai/service.ts), so it
// measures the real prompts, schemas and verification — not a copy of them. Runs are
// sequential to stay well inside rate limits, and it exits non-zero if the pass
// rate drops below the threshold, so it can gate a prompt change.

import { callClaude } from "../lib/ai/llm";
import { getModels } from "../lib/ai/config";
import { runExtraction, runFitAnalysis } from "../lib/ai/service";
import { COUNTRIES } from "../lib/jobs";
import {
  ANALYSIS_CASES,
  CV_TEXT,
  EXTRACTION_CASES,
} from "./fixtures";
import {
  scoreAnalysis,
  scoreExtraction,
  scoreOrdering,
  summarize,
  type CaseResult,
} from "./score";

const PASS_THRESHOLD = 0.85;
const TODAY = "2026-10-07";
// Rough per-call estimates (USD) for a heads-up before spending; not exact.
const EST_ANALYSIS_USD = 0.08;
const EST_EXTRACTION_USD = 0.03;

function loadEnv() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* no .env.local; rely on the real environment */
  }
}

async function main() {
  loadEnv();
  const confirmed = process.argv.includes("--yes");
  const models = getModels();
  const calls = ANALYSIS_CASES.length + EXTRACTION_CASES.length;
  const estimate =
    ANALYSIS_CASES.length * EST_ANALYSIS_USD +
    EXTRACTION_CASES.length * EST_EXTRACTION_USD;

  console.log("FireHunt AI evals");
  console.log(`  analysis model:   ${models.analyze}`);
  console.log(`  extraction model: ${models.extract}`);
  console.log(
    `  cases: ${ANALYSIS_CASES.length} analysis + ${EXTRACTION_CASES.length} extraction = ${calls} paid API calls (~$${estimate.toFixed(2)}, rough estimate)`,
  );

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\nANTHROPIC_API_KEY is not set (put it in .env.local). Nothing was run.");
    process.exit(2);
  }
  if (!confirmed) {
    console.log("\nDry run only. Re-run with  npm run eval -- --yes  to spend the credits.");
    return;
  }

  const results: CaseResult[] = [];
  const analysisScores: Record<string, number> = {};

  console.log("\n-- Fit analysis --");
  for (const c of ANALYSIS_CASES) {
    const out = await runFitAnalysis(
      callClaude,
      {
        job: { title: c.title, company: c.company, description: c.description },
        contacts: c.contacts,
        cvText: CV_TEXT,
        cvId: "eval-cv",
        cvName: "eval-cv.txt",
      },
      { model: models.analyze },
    );
    if (!out.ok) {
      results.push({ id: c.id, passed: false, failures: [`model call failed: ${out.code}`] });
    } else {
      analysisScores[c.id.replace("-fit", "")] = out.value.fit_score;
      results.push(scoreAnalysis(c, out.value));
    }
    report(results[results.length - 1]);
  }
  const ordering = scoreOrdering({
    strong: analysisScores["strong"],
    partial: analysisScores["partial"],
    weak: analysisScores["weak"],
  });
  results.push(ordering);
  report(ordering);

  console.log("\n-- Capture extraction --");
  for (const c of EXTRACTION_CASES) {
    const out = await runExtraction(
      callClaude,
      { ...c.input, countries: COUNTRIES, today: TODAY },
      { model: models.extract, now: new Date(`${TODAY}T00:00:00Z`) },
    );
    results.push(
      out.ok
        ? scoreExtraction(c, out.value)
        : { id: c.id, passed: false, failures: [`model call failed: ${out.code}`] },
    );
    report(results[results.length - 1]);
  }

  const s = summarize(results);
  console.log(
    `\nPassed ${s.passed}/${s.total} (${Math.round(s.rate * 100)}%) — threshold ${Math.round(PASS_THRESHOLD * 100)}%`,
  );
  process.exit(s.rate >= PASS_THRESHOLD ? 0 : 1);
}

function report(r: CaseResult) {
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.id}`);
  for (const f of r.failures) console.log(`        - ${f}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
