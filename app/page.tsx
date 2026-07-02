"use client";

// This is a Client Component ("use client" above) because it uses state,
// button clicks, and the browser's localStorage to remember your jobs.

import { useEffect, useMemo, useState } from "react";
import {
  COUNTRIES,
  JOBS_STORAGE_KEY,
  STATUSES,
  filterJobs,
  type Job,
  type JobStatus,
} from "@/lib/jobs";
import { ADZUNA_COUNTRIES, type AdzunaJob } from "@/lib/adzuna";
import CvManager from "@/app/CvManager";
import InsightsManager from "@/app/InsightsManager";
import PrepPrompt from "@/app/PrepPrompt";
import Bookmarklet from "@/app/Bookmarklet";
import DataBackup from "@/app/DataBackup";
import { getAllCvs } from "@/lib/cvStore";
import { roleLabel, type CvRole } from "@/lib/cvs";

type View = "jobs" | "cvs" | "insights";

// A lightweight view of a stored CV — just what a job card needs to show.
type CvMeta = { id: string; name: string; role: CvRole };

// Where jobs are saved inside your browser. The "v1" lets us change the
// shape later without clashing with old saved data.
const STORAGE_KEY = JOBS_STORAGE_KEY;

// A blank "add job" form.
const EMPTY_FORM = {
  title: "",
  company: "",
  country: COUNTRIES[0],
  url: "",
  salary: "",
  status: "interested" as JobStatus,
  notes: "",
};

// Shared styling for text inputs / selects so they all look the same.
const inputClass =
  "rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-accent/70";

export default function Home() {
  const [view, setView] = useState<View>("jobs"); // which tab is showing
  const [cvList, setCvList] = useState<CvMeta[]>([]); // CVs available to attach
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false); // has the initial load finished?

  // Filters
  const [country, setCountry] = useState("");
  const [query, setQuery] = useState("");

  // Add-job form
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);

  // Adzuna search
  const [showSearch, setShowSearch] = useState(false);
  const [sCountry, setSCountry] = useState(ADZUNA_COUNTRIES[0].code);
  const [sWhat, setSWhat] = useState("");
  const [sWhere, setSWhere] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [results, setResults] = useState<AdzunaJob[]>([]);
  const [imported, setImported] = useState<Set<string>>(new Set());

  // Load saved jobs once, when the page first opens (browser only).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setJobs(JSON.parse(raw) as Job[]);
    } catch {
      // ignore missing or corrupt data
    }
    setLoaded(true);
  }, []);

  // Save whenever the jobs change — but not before the first load has run,
  // otherwise we'd overwrite saved data with an empty list on startup.
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
  }, [jobs, loaded]);

  // Refresh the list of attachable CVs whenever the Jobs tab is shown, so CVs
  // uploaded in the CVs tab show up here too.
  useEffect(() => {
    if (view !== "jobs") return;
    getAllCvs()
      .then((list) =>
        setCvList(list.map((c) => ({ id: c.id, name: c.name, role: c.role }))),
      )
      .catch(() => setCvList([]));
  }, [view]);

  // If opened via the bookmarklet (URL has ?fh_ params), pre-fill and open the
  // Add-a-job form, then clean the URL so a refresh doesn't re-add the job.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const title = params.get("fh_title");
    const url = params.get("fh_url");
    if (!title && !url) return;
    setForm({
      ...EMPTY_FORM,
      title: title ?? "",
      company: params.get("fh_company") ?? "",
      url: url ?? "",
      notes: params.get("fh_notes") ?? "",
    });
    setView("jobs");
    setShowForm(true);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const visible = useMemo(
    () => filterJobs(jobs, { country, query }),
    [jobs, country, query],
  );

  function setField<K extends keyof typeof form>(
    key: K,
    value: (typeof form)[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.company.trim()) return; // both required
    const job: Job = {
      id: crypto.randomUUID(),
      title: form.title.trim(),
      company: form.company.trim(),
      country: form.country,
      url: form.url.trim(),
      salary: form.salary.trim(),
      status: form.status,
      notes: form.notes.trim(),
      dateAdded: new Date().toISOString(),
    };
    setJobs((prev) => [job, ...prev]);
    setForm(EMPTY_FORM);
    setShowForm(false);
  }

  function moveJob(id: string, status: JobStatus) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status } : j)));
  }

  function deleteJob(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }

  function attachCv(jobId: string, cvId: string) {
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, cvId: cvId || undefined } : j)),
    );
  }

  // Ask our own /api/adzuna endpoint for real jobs, then show them.
  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    setSearchError("");
    try {
      const params = new URLSearchParams({
        country: sCountry,
        what: sWhat,
        where: sWhere,
      });
      const res = await fetch(`/api/adzuna?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setSearchError(data.error || "Search failed. Please try again.");
        setResults([]);
      } else {
        setResults(data.results as AdzunaJob[]);
      }
    } catch {
      setSearchError("Could not reach the search service.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  // Copy a search result into your own board as a new job.
  function importAdzunaJob(a: AdzunaJob) {
    const countryLabel =
      ADZUNA_COUNTRIES.find((c) => c.code === sCountry)?.label ?? sCountry;
    const job: Job = {
      id: crypto.randomUUID(),
      title: a.title,
      company: a.company,
      country: countryLabel,
      url: a.url,
      salary: a.salary,
      status: "interested",
      notes: a.location ? `Location: ${a.location}` : "",
      dateAdded: new Date().toISOString(),
    };
    setJobs((prev) => [job, ...prev]);
    setImported((prev) => new Set(prev).add(a.externalId));
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            <span className="text-accent">Fire</span>Hunt
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Track every job you want to chase — Gulf, Australia, Singapore,
            Europe and beyond.
          </p>
        </div>
        <nav className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1 text-sm">
          <button
            onClick={() => setView("jobs")}
            className={`rounded-md px-3 py-1.5 font-medium transition ${
              view === "jobs"
                ? "bg-accent text-black"
                : "text-zinc-300 hover:bg-white/5"
            }`}
          >
            Jobs
          </button>
          <button
            onClick={() => setView("cvs")}
            className={`rounded-md px-3 py-1.5 font-medium transition ${
              view === "cvs"
                ? "bg-accent text-black"
                : "text-zinc-300 hover:bg-white/5"
            }`}
          >
            CVs
          </button>
          <button
            onClick={() => setView("insights")}
            className={`rounded-md px-3 py-1.5 font-medium transition ${
              view === "insights"
                ? "bg-accent text-black"
                : "text-zinc-300 hover:bg-white/5"
            }`}
          >
            Insights
          </button>
        </nav>
      </header>

      {view === "cvs" && <CvManager />}

      {view === "insights" && (
        <>
          <PrepPrompt />
          <InsightsManager />
        </>
      )}

      {view === "jobs" && (
        <>
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              onClick={() => {
                setShowSearch((v) => !v);
                setShowForm(false);
              }}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/5"
            >
              {showSearch ? "Close search" : "🔎 Search jobs"}
            </button>
            <button
              onClick={() => {
                setShowForm((v) => !v);
                setShowSearch(false);
              }}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90"
            >
              {showForm ? "Close" : "+ Add a job"}
            </button>
          </div>

          <Bookmarklet />

      {/* Add-job form */}
      {showForm && (
        <form
          onSubmit={handleAdd}
          className="mt-6 grid grid-cols-1 gap-4 rounded-xl border border-white/10 bg-white/5 p-5 sm:grid-cols-2"
        >
          <Field label="Job title *">
            <input
              className={inputClass}
              value={form.title}
              onChange={(e) => setField("title", e.target.value)}
              placeholder="e.g. Management Consultant"
            />
          </Field>
          <Field label="Company *">
            <input
              className={inputClass}
              value={form.company}
              onChange={(e) => setField("company", e.target.value)}
              placeholder="e.g. McKinsey & Company"
            />
          </Field>
          <Field label="Country">
            <select
              className={inputClass}
              value={form.country}
              onChange={(e) => setField("country", e.target.value)}
            >
              {COUNTRIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              className={inputClass}
              value={form.status}
              onChange={(e) => setField("status", e.target.value as JobStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Job link">
            <input
              className={inputClass}
              type="url"
              value={form.url}
              onChange={(e) => setField("url", e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <Field label="Salary (optional)">
            <input
              className={inputClass}
              value={form.salary}
              onChange={(e) => setField("salary", e.target.value)}
              placeholder="e.g. AED 30,000/mo"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <textarea
                className={inputClass}
                rows={3}
                value={form.notes}
                onChange={(e) => setField("notes", e.target.value)}
                placeholder="Referral contact, deadline, why you want it…"
              />
            </Field>
          </div>
          <div className="flex gap-3 sm:col-span-2">
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90"
            >
              Save job
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(EMPTY_FORM);
                setShowForm(false);
              }}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Adzuna search */}
      {showSearch && (
        <section className="mt-6 rounded-xl border border-white/10 bg-white/5 p-5">
          <form
            onSubmit={runSearch}
            className="grid grid-cols-1 gap-4 sm:grid-cols-4"
          >
            <div className="sm:col-span-2">
              <Field label="Keywords">
                <input
                  className={inputClass}
                  value={sWhat}
                  onChange={(e) => setSWhat(e.target.value)}
                  placeholder="e.g. data analyst, consultant"
                />
              </Field>
            </div>
            <Field label="Country">
              <select
                className={inputClass}
                value={sCountry}
                onChange={(e) => setSCountry(e.target.value)}
              >
                {ADZUNA_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="City (optional)">
              <input
                className={inputClass}
                value={sWhere}
                onChange={(e) => setSWhere(e.target.value)}
                placeholder="e.g. Amsterdam"
              />
            </Field>
            <div className="sm:col-span-4">
              <button
                type="submit"
                disabled={searching}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
              >
                {searching ? "Searching…" : "Search Adzuna"}
              </button>
            </div>
          </form>

          <p className="mt-3 text-xs text-zinc-500">
            Adzuna covers Australia, Singapore, the Netherlands, and Western
            Europe — not the Gulf. Add Gulf roles by hand with the Add a job
            button.
          </p>

          {searchError && (
            <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {searchError}
            </p>
          )}

          {results.length > 0 && (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((r) => {
                const added = imported.has(r.externalId);
                return (
                  <article
                    key={r.externalId}
                    className="flex flex-col rounded-xl border border-white/10 bg-black/20 p-3.5"
                  >
                    <h3 className="text-sm font-semibold leading-snug text-zinc-100">
                      {r.title}
                    </h3>
                    <p className="mt-0.5 text-sm text-zinc-400">{r.company}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                      {r.location && (
                        <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-300">
                          {r.location}
                        </span>
                      )}
                      {r.salary && (
                        <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-300">
                          {r.salary}
                        </span>
                      )}
                    </div>
                    {r.description && (
                      <p className="mt-2 line-clamp-3 text-xs text-zinc-500">
                        {r.description}
                      </p>
                    )}
                    <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                      {r.url ? (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-accent hover:underline"
                        >
                          View ↗
                        </a>
                      ) : (
                        <span />
                      )}
                      <button
                        onClick={() => importAdzunaJob(r)}
                        disabled={added}
                        className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-black transition hover:opacity-90 disabled:cursor-default disabled:bg-emerald-500/20 disabled:text-emerald-300"
                      >
                        {added ? "Added ✓" : "+ Add to board"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title or company…"
          className={`${inputClass} min-w-56 flex-1`}
        />
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className={inputClass}
        >
          <option value="">All countries</option>
          {COUNTRIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="text-sm text-zinc-500">
          {visible.length} of {jobs.length} job{jobs.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Board (or empty state) */}
      {jobs.length === 0 ? (
        <EmptyState onAdd={() => setShowForm(true)} />
      ) : (
        <div className="mt-6 flex gap-4 overflow-x-auto pb-4">
          {STATUSES.map((s) => {
            const columnJobs = visible.filter((j) => j.status === s.id);
            return (
              <section key={s.id} className="flex w-72 shrink-0 flex-col">
                <div
                  className={`mb-3 flex items-center justify-between rounded-lg border px-3 py-2 ${s.accent}`}
                >
                  <span className="text-sm font-semibold">{s.label}</span>
                  <span className="text-xs opacity-70">{columnJobs.length}</span>
                </div>
                <div className="flex flex-col gap-3">
                  {columnJobs.map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      cvs={cvList}
                      onMove={moveJob}
                      onDelete={deleteJob}
                      onAttach={attachCv}
                    />
                  ))}
                  {columnJobs.length === 0 && (
                    <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-xs text-zinc-600">
                      Nothing here yet
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
        </>
      )}

      <DataBackup />
    </div>
  );
}

/** A labelled form field wrapper. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-zinc-300">{label}</span>
      {children}
    </label>
  );
}

/** A single job card shown inside a board column. */
function JobCard({
  job,
  cvs,
  onMove,
  onDelete,
  onAttach,
}: {
  job: Job;
  cvs: CvMeta[];
  onMove: (id: string, status: JobStatus) => void;
  onDelete: (id: string) => void;
  onAttach: (jobId: string, cvId: string) => void;
}) {
  // Only treat a CV as attached if it still exists in the list.
  const attachedId =
    job.cvId && cvs.some((c) => c.id === job.cvId) ? job.cvId : "";
  return (
    <article className="rounded-xl border border-white/10 bg-white/5 p-3.5 transition hover:border-white/20">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold leading-snug text-zinc-100">
          {job.title}
        </h3>
        <button
          onClick={() => onDelete(job.id)}
          aria-label="Delete job"
          title="Delete"
          className="shrink-0 rounded p-1 text-zinc-500 transition hover:bg-white/10 hover:text-red-400"
        >
          ✕
        </button>
      </div>
      <p className="mt-0.5 text-sm text-zinc-400">{job.company}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-300">
          {job.country}
        </span>
        {job.salary && (
          <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-300">
            {job.salary}
          </span>
        )}
      </div>

      {job.notes && (
        <p className="mt-2 line-clamp-3 text-xs text-zinc-500">{job.notes}</p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <select
          value={job.status}
          onChange={(e) => onMove(job.id, e.target.value as JobStatus)}
          className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-accent/70"
        >
          {STATUSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {job.url && (
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-accent hover:underline"
          >
            Open ↗
          </a>
        )}
      </div>

      <div className="mt-2">
        {cvs.length === 0 ? (
          <p className="text-[11px] text-zinc-600">
            No CVs yet — add one in the CVs tab to attach it.
          </p>
        ) : (
          <select
            value={attachedId}
            onChange={(e) => onAttach(job.id, e.target.value)}
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-accent/70"
          >
            <option value="">— No CV attached —</option>
            {cvs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({roleLabel(c.role)})
              </option>
            ))}
          </select>
        )}
      </div>

      <p className="mt-2 text-[11px] text-zinc-600">
        Added {new Date(job.dateAdded).toLocaleDateString()}
      </p>
    </article>
  );
}

/** Shown when there are no jobs saved yet. */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mt-16 flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 py-20 text-center">
      <p className="text-lg font-semibold text-zinc-200">No jobs yet</p>
      <p className="mt-1 max-w-sm text-sm text-zinc-500">
        Add the first role you want to chase. You can paste anything you find
        online.
      </p>
      <button
        onClick={onAdd}
        className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90"
      >
        + Add your first job
      </button>
    </div>
  );
}
