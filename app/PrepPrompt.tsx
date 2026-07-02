"use client";

// The free "AI interview prep" tool: you fill in a few details, FireHunt builds
// a strong prompt, you copy it into your own free Claude/ChatGPT, then paste the
// answer into the company's Insights below. No API key, no cost.

import { useState } from "react";
import { buildPrepPrompt, type PrepInput } from "@/lib/prep";

const inputClass =
  "rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-accent/70";

const SENIORITY = [
  "",
  "Internship",
  "Entry / Graduate",
  "Mid-level",
  "Senior",
  "Lead / Manager",
];

const EMPTY: PrepInput = {
  role: "",
  company: "",
  location: "",
  seniority: "",
  jobDescription: "",
};

export default function PrepPrompt() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PrepInput>(EMPTY);
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);

  function setField<K extends keyof PrepInput>(key: K, value: PrepInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function build(e: React.FormEvent) {
    e.preventDefault();
    setPrompt(buildPrepPrompt(form));
    setCopied(false);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be blocked; the user can still select the text manually
    }
  }

  return (
    <div className="mt-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/5"
      >
        {open ? "Hide interview-prep tool" : "🧠 Build an interview-prep prompt"}
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-5">
          <p className="max-w-2xl text-sm text-zinc-400">
            Fill this in and FireHunt writes a strong prompt. Copy it, paste it
            into your own free Claude or ChatGPT, then paste the answer into the
            company below. No API key, no cost.
          </p>

          <form
            onSubmit={build}
            className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
          >
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-300">Role / title *</span>
              <input
                className={inputClass}
                value={form.role}
                onChange={(e) => setField("role", e.target.value)}
                placeholder="e.g. Strategy Consultant"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-300">Company</span>
              <input
                className={inputClass}
                value={form.company}
                onChange={(e) => setField("company", e.target.value)}
                placeholder="e.g. Bain & Company"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-300">Location / region</span>
              <input
                className={inputClass}
                value={form.location}
                onChange={(e) => setField("location", e.target.value)}
                placeholder="e.g. Dubai, UAE"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-300">Seniority</span>
              <select
                className={inputClass}
                value={form.seniority}
                onChange={(e) => setField("seniority", e.target.value)}
              >
                {SENIORITY.map((s) => (
                  <option key={s} value={s}>
                    {s || "Any / not sure"}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-zinc-300">
                  Job description (optional — paste it for sharper prep)
                </span>
                <textarea
                  className={inputClass}
                  rows={4}
                  value={form.jobDescription}
                  onChange={(e) => setField("jobDescription", e.target.value)}
                  placeholder="Paste the job posting text here…"
                />
              </label>
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90"
              >
                Build prompt
              </button>
            </div>
          </form>

          {prompt && (
            <div className="mt-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-300">
                  Your prompt
                </span>
                <button
                  onClick={copy}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-white/5"
                >
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
              <textarea
                readOnly
                value={prompt}
                rows={12}
                className={`${inputClass} mt-2 w-full font-mono text-xs`}
              />
              <p className="mt-2 text-xs text-zinc-500">
                Paste this into Claude or ChatGPT, then copy its answer into the
                company below (the How the interview goes / What it takes to
                succeed fields).
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
