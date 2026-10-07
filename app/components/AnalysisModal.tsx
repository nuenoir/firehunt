"use client";

// The "Analyze fit" result: an evidence-backed assessment of one CV against one job.
// Everything the AI claims about the CV is shown next to the exact quote it was
// based on, and a confidence badge says how much of it survived verification.

import { useEffect, useRef, useState } from "react";
import type { Job } from "@/lib/jobs";
import type { Confidence, StoredAnalysis } from "@/lib/ai/schemas";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; the text is still selectable
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-white/15 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:bg-white/5"
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  medium: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  low: "border-red-400/40 bg-red-400/10 text-red-300",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "Every claim verified against your CV",
  medium: "Mostly verified — some claims removed",
  low: "Low confidence — check this one carefully",
};

function scoreColor(score: number): string {
  if (score >= 75) return "text-emerald-300";
  if (score >= 50) return "text-amber-300";
  return "text-red-300";
}

export default function AnalysisModal({
  job,
  analysis,
  busy,
  error,
  onRerun,
  onClose,
}: {
  job: Job;
  analysis: StoredAnalysis;
  busy: boolean;
  error: string;
  onRerun: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [channel, setChannel] = useState<"email" | "whatsapp">("email");

  // Open as a true modal (focus trap, Esc to close, backdrop) when mounted.
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself) closes it.
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="m-auto max-h-[90vh] w-[min(46rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-white/10 bg-[#11161d] p-0 text-zinc-200 backdrop:bg-black/70"
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-accent">
              ✨ Fit analysis{analysis.demo ? " · sample" : ""}
            </p>
            <h2 className="mt-1 text-lg font-semibold text-zinc-100">
              {job.title}
            </h2>
            <p className="text-sm text-zinc-400">{job.company}</p>
          </div>
          <button
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
            className="rounded p-1.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        <div className="mt-5 flex items-center gap-4 rounded-xl border border-white/10 bg-white/5 p-4">
          <div className={`text-4xl font-bold ${scoreColor(analysis.fit_score)}`}>
            {analysis.fit_score}
            <span className="text-base font-medium text-zinc-500">/100</span>
          </div>
          <p className="text-sm leading-relaxed text-zinc-300">{analysis.verdict}</p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-full border px-2 py-0.5 ${CONFIDENCE_STYLE[analysis.confidence]}`}
          >
            {CONFIDENCE_LABEL[analysis.confidence]}
          </span>
          {analysis.removed_unverified > 0 && (
            <span className="text-zinc-500">
              {analysis.removed_unverified} claim
              {analysis.removed_unverified === 1 ? " was" : "s were"} removed
              because the quoted evidence wasn&apos;t found in your CV.
            </span>
          )}
        </div>

        {analysis.strengths.length > 0 && (
          <section className="mt-6">
            <h3 className="text-sm font-semibold text-zinc-100">
              Where you match
            </h3>
            <ul className="mt-2 space-y-3">
              {analysis.strengths.map((s, i) => (
                <li key={i} className="text-sm">
                  <p className="text-zinc-200">{s.point}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Job asks for: {s.job_requirement}
                  </p>
                  <blockquote className="mt-1 border-l-2 border-emerald-400/50 pl-3 text-xs italic text-zinc-400">
                    From your CV: &ldquo;{s.cv_evidence}&rdquo;
                  </blockquote>
                </li>
              ))}
            </ul>
          </section>
        )}

        {analysis.gaps.length > 0 && (
          <section className="mt-6">
            <h3 className="text-sm font-semibold text-zinc-100">
              Honest gaps
            </h3>
            <ul className="mt-2 space-y-2">
              {analysis.gaps.map((g, i) => (
                <li key={i} className="text-sm">
                  <p className="text-zinc-200">{g.requirement}</p>
                  <p className="text-xs text-zinc-400">{g.note}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {analysis.tailored_bullets.length > 0 && (
          <section className="mt-6">
            <h3 className="text-sm font-semibold text-zinc-100">
              CV bullets reworded for this role
            </h3>
            <p className="text-xs text-zinc-500">
              Based only on experience already in your CV.
            </p>
            <ul className="mt-2 space-y-3">
              {analysis.tailored_bullets.map((b, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm"
                >
                  <p className="text-zinc-200">{b.bullet}</p>
                  <div className="mt-2 flex items-start justify-between gap-3">
                    <p className="text-[11px] italic text-zinc-500">
                      Source: &ldquo;{b.cv_evidence}&rdquo;
                    </p>
                    <CopyButton text={b.bullet} label="Copy" />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">
              Reach out directly
            </h3>
            <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5 text-xs">
              {(["email", "whatsapp"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setChannel(c)}
                  className={`rounded-md px-2.5 py-1 font-medium transition ${
                    channel === c
                      ? "bg-accent text-black"
                      : "text-zinc-300 hover:bg-white/5"
                  }`}
                >
                  {c === "email" ? "Email" : "WhatsApp"}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
            {channel === "email" ? (
              <>
                <p className="text-xs text-zinc-500">Subject</p>
                <p className="text-zinc-200">{analysis.outreach.email_subject}</p>
                <pre className="mt-3 whitespace-pre-wrap font-sans text-zinc-300">
                  {analysis.outreach.email_body}
                </pre>
                <div className="mt-3 flex gap-2">
                  <CopyButton
                    text={analysis.outreach.email_subject}
                    label="Copy subject"
                  />
                  <CopyButton
                    text={analysis.outreach.email_body}
                    label="Copy email"
                  />
                </div>
              </>
            ) : (
              <>
                <pre className="whitespace-pre-wrap font-sans text-zinc-300">
                  {analysis.outreach.whatsapp_message}
                </pre>
                <div className="mt-3">
                  <CopyButton
                    text={analysis.outreach.whatsapp_message}
                    label="Copy message"
                  />
                </div>
              </>
            )}
          </div>
        </section>

        {error && (
          <p className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
          <p className="text-[11px] leading-relaxed text-zinc-500">
            {analysis.demo
              ? "Sample analysis shown in demo mode — no AI call was made."
              : `Generated ${new Date(analysis.generated_at).toLocaleString()} from “${analysis.cv_name}” · ${analysis.model}.`}{" "}
            AI can be wrong — check everything before you send it.
          </p>
          <button
            onClick={onRerun}
            disabled={busy}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5 disabled:opacity-50"
          >
            {busy ? "Re-running…" : analysis.demo ? "Reload sample" : "↻ Re-run"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
