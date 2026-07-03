"use client";

// This is a Client Component ("use client" above) because it uses state,
// button clicks, and the browser's localStorage to remember your jobs.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  COUNTRIES,
  JOBS_STORAGE_KEY,
  STATUSES,
  dueStatus,
  needsAttention,
  filterJobs,
  jobStats,
  type DueStatus,
  type Job,
  type JobStatus,
} from "@/lib/jobs";
import { ADZUNA_COUNTRIES, type AdzunaJob } from "@/lib/adzuna";
import { GULF_LOCATIONS } from "@/lib/jooble";
import { supabase, syncEnabled } from "@/lib/supabase";
import {
  fetchRemoteJobs,
  upsertRemoteJobs,
  deleteRemoteJobs,
} from "@/lib/jobsRemote";
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
  deadline: "",
  followUpDate: "",
};

// Shared styling for text inputs / selects so they all look the same.
const inputClass =
  "rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-accent/70";

export default function Home() {
  const [view, setView] = useState<View>("jobs"); // which tab is showing
  const [cvList, setCvList] = useState<CvMeta[]>([]); // CVs available to attach
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false); // has the initial load finished?
  const [todayIso, setTodayIso] = useState(""); // today as YYYY-MM-DD (set on the client)

  // --- Cloud sync (Supabase) ---
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [cloudReady, setCloudReady] = useState(false); // initial pull+merge done
  const [syncStatus, setSyncStatus] = useState<
    "idle" | "syncing" | "synced" | "error"
  >("idle");
  const [email, setEmail] = useState(""); // sign-in email field
  const [authMsg, setAuthMsg] = useState(""); // feedback under the sign-in form
  const jobsRef = useRef<Job[]>([]); // always-current jobs, for use inside effects
  jobsRef.current = jobs;
  const lastSyncedRef = useRef<Map<string, string>>(new Map()); // id -> JSON last pushed

  // Filters
  const [country, setCountry] = useState("");
  const [query, setQuery] = useState("");

  // Add-job form
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);

  // Adzuna search
  const [showSearch, setShowSearch] = useState(false);
  // Search target, encoded as "provider:value" — e.g. "jooble:United Arab
  // Emirates" (Gulf) or "adzuna:au". Default to a Gulf country.
  const [sTarget, setSTarget] = useState("jooble:United Arab Emirates");
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

  // Today's date (client-only, so server/client render match), used to flag
  // deadlines and follow-ups that are due soon or overdue.
  useEffect(() => {
    setTodayIso(new Date().toISOString().slice(0, 10));
  }, []);

  // Watch auth state: restore an existing session and react to sign-in/out.
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      if (u) setUser({ id: u.id, email: u.email ?? "" });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      if (u) {
        setUser({ id: u.id, email: u.email ?? "" });
      } else {
        setUser(null);
        setCloudReady(false);
        lastSyncedRef.current = new Map();
        setSyncStatus("idle");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // On sign-in: pull the user's jobs from the cloud, merge in any local-only
  // jobs (a one-time migration), then switch the board to the merged set.
  useEffect(() => {
    if (!supabase || !user || !loaded) return;
    let cancelled = false;
    (async () => {
      setSyncStatus("syncing");
      try {
        const remote = await fetchRemoteJobs();
        if (cancelled) return;
        const local = jobsRef.current;
        const remoteIds = new Set(remote.map((r) => r.id));
        const localOnly = local.filter((j) => !remoteIds.has(j.id));
        if (localOnly.length) await upsertRemoteJobs(localOnly, user.id);
        const merged = [...remote, ...localOnly].sort((a, b) =>
          (b.dateAdded || "").localeCompare(a.dateAdded || ""),
        );
        lastSyncedRef.current = new Map(
          merged.map((j) => [j.id, JSON.stringify(j)]),
        );
        setJobs(merged);
        setCloudReady(true);
        setSyncStatus("synced");
      } catch {
        if (!cancelled) setSyncStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loaded]);

  // While signed in, push local changes to the cloud: upsert new/edited jobs and
  // delete removed ones, diffed against what we last pushed.
  useEffect(() => {
    if (!supabase || !user || !cloudReady) return;
    const prev = lastSyncedRef.current;
    const currentIds = new Set(jobs.map((j) => j.id));
    const toUpsert = jobs.filter((j) => prev.get(j.id) !== JSON.stringify(j));
    const toDelete = [...prev.keys()].filter((id) => !currentIds.has(id));
    if (toUpsert.length === 0 && toDelete.length === 0) return;
    setSyncStatus("syncing");
    (async () => {
      try {
        await upsertRemoteJobs(toUpsert, user.id);
        await deleteRemoteJobs(toDelete);
        lastSyncedRef.current = new Map(
          jobs.map((j) => [j.id, JSON.stringify(j)]),
        );
        setSyncStatus("synced");
      } catch {
        setSyncStatus("error");
      }
    })();
  }, [jobs, user, cloudReady]);

  // Email a magic sign-in link (no password to manage).
  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !email.trim()) return;
    setAuthMsg("Sending…");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setAuthMsg(
      error
        ? `Couldn't send the link: ${error.message}`
        : "Check your email for a sign-in link ✉ (it may take a minute).",
    );
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setEmail("");
    setAuthMsg("");
  }

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
      salary: params.get("fh_salary") ?? "",
      notes: cleanCapturedNotes(params.get("fh_notes") ?? ""),
    });
    setView("jobs");
    setShowForm(true);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const visible = useMemo(
    () => filterJobs(jobs, { country, query }),
    [jobs, country, query],
  );

  // Contacts detected in the add-job form's notes, shown up front while editing.
  const formContacts = extractContacts(form.notes);

  // How many still-active jobs have a follow-up or deadline that needs attention.
  const dueCount = useMemo(() => {
    if (!todayIso) return 0;
    return jobs.filter(
      (j) =>
        j.status !== "rejected" &&
        (needsAttention(dueStatus(j.followUpDate, todayIso)) ||
          needsAttention(dueStatus(j.deadline, todayIso))),
    ).length;
  }, [jobs, todayIso]);

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
      deadline: form.deadline || undefined,
      followUpDate: form.followUpDate || undefined,
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
  // Split "provider:value" into its two parts.
  function searchProviderAndValue() {
    const sep = sTarget.indexOf(":");
    return { provider: sTarget.slice(0, sep), value: sTarget.slice(sep + 1) };
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    setSearchError("");
    try {
      const { provider, value } = searchProviderAndValue();
      let url: string;
      if (provider === "jooble") {
        // Jooble's Gulf data only resolves by COUNTRY, not city — so keep the
        // country as the location and fold any typed city into the keywords.
        const keywords = sWhere.trim() ? `${sWhat} ${sWhere.trim()}`.trim() : sWhat;
        url = `/api/jooble?${new URLSearchParams({ what: keywords, location: value }).toString()}`;
      } else {
        url = `/api/adzuna?${new URLSearchParams({ country: value, what: sWhat, where: sWhere }).toString()}`;
      }
      const res = await fetch(url);
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
  function currentTargetLabel(): string {
    const { provider, value } = searchProviderAndValue();
    if (provider === "jooble") {
      return GULF_LOCATIONS.find((g) => g.location === value)?.label ?? value;
    }
    return ADZUNA_COUNTRIES.find((c) => c.code === value)?.label ?? value;
  }

  function importAdzunaJob(a: AdzunaJob) {
    const countryLabel = currentTargetLabel();
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

      {syncEnabled && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm">
          {user ? (
            <>
              <span className="text-zinc-300">
                ☁ Synced as{" "}
                <strong className="text-zinc-100">{user.email}</strong>
                <span className="ml-2 text-xs text-zinc-500">
                  {syncStatus === "syncing"
                    ? "· saving…"
                    : syncStatus === "error"
                      ? "· ⚠ sync error"
                      : "· up to date"}
                </span>
              </span>
              <button
                onClick={signOut}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <span className="text-zinc-400">
                🔒 Saved on this device only.{" "}
                <span className="text-zinc-300">
                  Sign in to sync across devices:
                </span>
              </span>
              <form
                onSubmit={sendMagicLink}
                className="flex flex-wrap items-center gap-2"
              >
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  className={`${inputClass} py-1.5`}
                />
                <button
                  type="submit"
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-black transition hover:opacity-90"
                >
                  Email me a link
                </button>
                {authMsg && (
                  <span className="w-full text-xs text-zinc-400 sm:w-auto">
                    {authMsg}
                  </span>
                )}
              </form>
            </>
          )}
        </div>
      )}

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
          <Field label="Deadline (optional)">
            <input
              className={inputClass}
              type="date"
              value={form.deadline}
              onChange={(e) => setField("deadline", e.target.value)}
            />
          </Field>
          <Field label="Next follow-up (optional)">
            <input
              className={inputClass}
              type="date"
              value={form.followUpDate}
              onChange={(e) => setField("followUpDate", e.target.value)}
            />
          </Field>
          {(formContacts.emails.length > 0 ||
            formContacts.phones.length > 0) && (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-sm font-medium text-zinc-300">
                Contacts found in this job
              </span>
              <ContactChips
                emails={formContacts.emails}
                phones={formContacts.phones}
              />
            </div>
          )}
          <div className="sm:col-span-2">
            <Field label="Notes">
              <textarea
                className={inputClass}
                rows={12}
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
                value={sTarget}
                onChange={(e) => setSTarget(e.target.value)}
              >
                <optgroup label="Gulf (via Jooble)">
                  {GULF_LOCATIONS.map((g) => (
                    <option key={g.location} value={`jooble:${g.location}`}>
                      {g.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Adzuna (Australia, Singapore, Europe…)">
                  {ADZUNA_COUNTRIES.map((c) => (
                    <option key={c.code} value={`adzuna:${c.code}`}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
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
            Gulf countries (UAE, Saudi, Qatar…) search via Jooble; Australia,
            Singapore and Europe via Adzuna. Gulf results are matched by country
            (a typed city becomes an extra keyword). Jooble has limited free Gulf
            data, so use the bookmarklet or Add a job for anything it misses.
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

      {jobs.length > 0 && <Dashboard jobs={jobs} todayIso={todayIso} />}

      {dueCount > 0 && (
        <div className="mt-6 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-200">
          🔔 {dueCount} job{dueCount === 1 ? "" : "s"} need
          {dueCount === 1 ? "s" : ""} attention — a follow-up or deadline is due
          soon or overdue.
        </div>
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
                      todayIso={todayIso}
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

/** Strip LinkedIn's trailing "…more" / "see more" toggle text from a captured note. */
function cleanCapturedNotes(s: string): string {
  return s
    .replace(/\s*(?:…|\.\.\.)\s*(?:more|less)\s*$/i, "")
    .replace(/\n\s*(?:see|show)\s+(?:more|less)\s*$/i, "")
    .trim();
}

/** A contact (email or phone) plus a best-effort guess at whose it is. */
type Contact = { value: string; name: string };

/** Capitalised words that can follow a trigger but aren't people, to avoid false labels. */
const NAME_STOP = new Set(
  "center centre team staff group office division department board call email phone mobile product owner manager senior junior lead role job apply now today please about we you your our us me the this that here there remote onsite hybrid monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(
    " ",
  ),
);
function looksLikeName(s: string): boolean {
  return !!s && !NAME_STOP.has(s.split(/\s+/)[0].toLowerCase());
}

/** Best-effort: find a person's name mentioned right next to a contact in the text.
 *  Requires a trigger word ("contact/call/reach out to…") immediately followed by a
 *  Capitalised name — case-sensitive on the name so we don't grab "us"/"today". */
function nameNear(text: string, value: string): string {
  const idx = text.indexOf(value);
  if (idx < 0) return "";
  const before = text.slice(Math.max(0, idx - 90), idx);
  const after = text.slice(idx + value.length, idx + value.length + 60);
  const re =
    /(?:[Cc]ontact|[Cc]all|[Rr]each(?:\s+out)?(?:\s+to)?|[Ss]peak\s+(?:to|with)|[Aa]sk\s+for|[Aa]ttention|[Aa]ttn|[Rr]egards|[Ss]incerely|[Ee]mail|[Mm]essage)[\s:,]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g;
  let m: RegExpExecArray | null;
  let last = "";
  while ((m = re.exec(before)) !== null) if (looksLikeName(m[1])) last = m[1];
  if (last) return last.trim();
  re.lastIndex = 0;
  while ((m = re.exec(after)) !== null)
    if (looksLikeName(m[1])) return m[1].trim();
  return "";
}

/** Derive a name from an email local part (rob → Rob), skipping role addresses. */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] || "";
  if (
    /^(careers?|jobs?|hr|info|admin|hello|contact|recruit(?:ing|ment)?|talent|apply|applications?|team|support|office|no-?reply|enquir(?:y|ies)|sales|marketing)$/i.test(
      local,
    )
  )
    return "";
  const parts = local.split(/[._-]+/).filter((p) => /^[A-Za-z]{2,15}$/.test(p));
  if (parts.length === 0 || parts.length > 3) return "";
  return parts
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

/** Pull email + phone contacts out of a job's notes, each with a best-effort name. */
function extractContacts(text: string): { emails: Contact[]; phones: Contact[] } {
  if (!text) return { emails: [], phones: [] };
  const uniqBy = (arr: Contact[]) => {
    const seen = new Set<string>();
    return arr.filter((c) =>
      seen.has(c.value) ? false : (seen.add(c.value), true),
    );
  };
  const emailStrs =
    text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
  const phoneStrs = (
    text.match(/(\+\d[\d ().\-]{6,}\d)|(\b0\d[\d ().\-]{7,}\d)/g) || []
  ).filter((p) => {
    const g = p.replace(/\D/g, "");
    return g.length >= 8 && g.length <= 15;
  });
  const emails = uniqBy(
    emailStrs.map((e) => {
      const v = e.trim();
      return { value: v, name: nameNear(text, v) || nameFromEmail(v) };
    }),
  );
  const phones = uniqBy(
    phoneStrs.map((p) => {
      const v = p.trim();
      return { value: v, name: nameNear(text, v) };
    }),
  );
  return { emails, phones };
}

/** A single contact pill you can click to copy (text stays selectable too).
 *  Shows a best-effort person name in front of the value when one was found. */
function ContactChip({
  icon,
  value,
  name,
}: {
  icon: string;
  value: string;
  name?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; the text is still selectable to copy by hand
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={name ? `Click to copy ${value} (${name})` : `Click to copy ${value}`}
      className="max-w-full cursor-copy select-text truncate rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-accent transition hover:bg-accent/20"
    >
      {copied ? (
        "Copied ✓"
      ) : (
        <>
          {icon} {name && <span className="font-semibold">{name} · </span>}
          {value}
        </>
      )}
    </button>
  );
}

/** Click-to-copy email / phone chips, shared by the add-job form and job cards. */
function ContactChips({
  emails,
  phones,
}: {
  emails: Contact[];
  phones: Contact[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {emails.map((e) => (
        <ContactChip key={e.value} icon="✉" value={e.value} name={e.name} />
      ))}
      {phones.map((p) => (
        <ContactChip key={p.value} icon="☎" value={p.value} name={p.name} />
      ))}
    </div>
  );
}

/** A date pill that turns red when overdue and amber when due today/soon. */
function DateBadge({
  label,
  dateIso,
  todayIso,
}: {
  label: string;
  dateIso: string;
  todayIso: string;
}) {
  const status: DueStatus = dueStatus(dateIso, todayIso);
  const color =
    status === "overdue"
      ? "text-red-300 border-red-400/40 bg-red-400/10"
      : status === "today" || status === "soon"
        ? "text-amber-300 border-amber-400/40 bg-amber-400/10"
        : "text-zinc-300 border-white/10 bg-black/30";
  const when = new Date(`${dateIso}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
  const suffix =
    status === "overdue" ? " · overdue" : status === "today" ? " · today" : "";
  return (
    <span className={`rounded-full border px-2 py-0.5 ${color}`}>
      {label}: {when}
      {suffix}
    </span>
  );
}

/** Bar colours per pipeline stage for the funnel bar. */
const BAR_COLORS: Record<JobStatus, string> = {
  interested: "bg-sky-400/70",
  applied: "bg-amber-400/70",
  interview: "bg-violet-400/70",
  offer: "bg-emerald-400/70",
  rejected: "bg-zinc-500/70",
};

/** A single stat tile: a big count with a label, tinted per stage. */
function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div
      className={`flex min-w-[4.5rem] flex-1 flex-col rounded-lg border px-3 py-2 ${accent}`}
    >
      <span className="text-xl font-bold leading-none">{value}</span>
      <span className="mt-1 text-xs opacity-80">{label}</span>
    </div>
  );
}

/** Pipeline dashboard: stage tiles, a funnel bar, and a couple of key metrics. */
function Dashboard({ jobs, todayIso }: { jobs: Job[]; todayIso: string }) {
  const stats = jobStats(jobs);
  const weekAgo = todayIso
    ? new Date(new Date(`${todayIso}T00:00:00`).getTime() - 6 * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : "";
  const addedThisWeek = weekAgo
    ? jobs.filter((j) => (j.dateAdded || "").slice(0, 10) >= weekAgo).length
    : 0;
  return (
    <section className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap gap-2">
        <StatTile
          label="Total"
          value={stats.total}
          accent="border-white/15 bg-white/5 text-zinc-100"
        />
        {STATUSES.map((s) => (
          <StatTile
            key={s.id}
            label={s.label}
            value={stats.byStatus[s.id]}
            accent={s.accent}
          />
        ))}
      </div>

      {stats.total > 0 && (
        <div
          className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-black/30"
          title="Share of jobs in each stage"
        >
          {STATUSES.map((s) => {
            const pct = (stats.byStatus[s.id] / stats.total) * 100;
            return pct > 0 ? (
              <div
                key={s.id}
                style={{ width: `${pct}%` }}
                className={BAR_COLORS[s.id]}
                title={`${s.label}: ${stats.byStatus[s.id]}`}
              />
            ) : null;
          })}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-400">
        <span>
          Response rate:{" "}
          <strong className="text-zinc-100">
            {Math.round(stats.responseRate * 100)}%
          </strong>{" "}
          <span className="text-zinc-500">
            (interviews + offers vs. all {stats.appliedOrBeyond} you applied to)
          </span>
        </span>
        <span>
          Added this week:{" "}
          <strong className="text-zinc-100">{addedThisWeek}</strong>
        </span>
      </div>
    </section>
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
  todayIso,
  onMove,
  onDelete,
  onAttach,
}: {
  job: Job;
  cvs: CvMeta[];
  todayIso: string;
  onMove: (id: string, status: JobStatus) => void;
  onDelete: (id: string) => void;
  onAttach: (jobId: string, cvId: string) => void;
}) {
  // Only treat a CV as attached if it still exists in the list.
  const attachedId =
    job.cvId && cvs.some((c) => c.id === job.cvId) ? job.cvId : "";
  // Contacts lifted out of the notes, shown up front so you don't have to scroll.
  const contacts = extractContacts(job.notes);
  const hasContacts = contacts.emails.length > 0 || contacts.phones.length > 0;
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

      {hasContacts && (
        <div className="mt-2">
          <ContactChips emails={contacts.emails} phones={contacts.phones} />
        </div>
      )}

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

      {(job.deadline || job.followUpDate) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {job.deadline && (
            <DateBadge
              label="⏳ Deadline"
              dateIso={job.deadline}
              todayIso={todayIso}
            />
          )}
          {job.followUpDate && (
            <DateBadge
              label="🔔 Follow-up"
              dateIso={job.followUpDate}
              todayIso={todayIso}
            />
          )}
        </div>
      )}

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
