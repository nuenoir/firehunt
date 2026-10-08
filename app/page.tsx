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
  type Job,
  type JobStatus,
} from "@/lib/jobs";
import { ADZUNA_COUNTRIES, type AdzunaJob } from "@/lib/adzuna";
import { GULF_LOCATIONS } from "@/lib/jooble";
import { getAccessToken, supabase, syncEnabled } from "@/lib/supabase";
import {
  fetchRemoteJobs,
  upsertRemoteJobs,
  deleteRemoteJobs,
} from "@/lib/jobsRemote";
import {
  planIsEmpty,
  planPush,
  pushChanges,
  reconcileOnSignIn,
  type JobCloud,
  type KnownIdStore,
} from "@/lib/syncEngine";
import { loadKnownIds, saveKnownIds } from "@/lib/syncKnown";
import CvManager from "@/app/CvManager";
import InsightsManager from "@/app/InsightsManager";
import PrepPrompt from "@/app/PrepPrompt";
import Bookmarklet from "@/app/Bookmarklet";
import DataBackup from "@/app/DataBackup";
import JobCard from "@/app/components/JobCard";
import Dashboard from "@/app/components/Dashboard";
import ContactChips from "@/app/components/ContactChips";
import AnalysisModal from "@/app/components/AnalysisModal";
import DemoCvs from "@/app/components/DemoCvs";
import { EmptyState, Field, inputClass } from "@/app/components/ui";
import { getAllCvs } from "@/lib/cvStore";
import { fetchRemoteCvs } from "@/lib/cvsRemote";
import type { CvMeta } from "@/lib/cvs";
import {
  cleanCapturedNotes,
  extractContacts,
  splitStoredContacts,
  type StoredContact,
} from "@/lib/contacts";
import {
  requestAnalysis,
  requestExtraction,
  type CapturePayload,
} from "@/lib/ai/clientApi";
import type { StoredAnalysis } from "@/lib/ai/schemas";
import { DEMO_CVS, buildDemoJobs, demoAnalysis } from "@/lib/demo";

type View = "jobs" | "cvs" | "insights";

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

// How many search results to show per page.
const SEARCH_PAGE_SIZE = 30;

// The real cloud and sync-history store for one signed-in user, in the shape the
// tested sync engine (lib/syncEngine.ts) expects.
function jobCloud(userId: string): JobCloud {
  return {
    fetch: fetchRemoteJobs,
    upsert: (jobs) => upsertRemoteJobs(jobs, userId),
    remove: deleteRemoteJobs,
  };
}
function knownJobIds(userId: string): KnownIdStore {
  return {
    load: () => loadKnownIds("jobs", userId),
    save: (ids) => saveKnownIds("jobs", userId, ids),
  };
}

export default function Home() {
  const [view, setView] = useState<View>("jobs"); // which tab is showing
  const [cvList, setCvList] = useState<CvMeta[]>([]); // CVs available to attach
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false); // has the initial load finished?
  const [todayIso, setTodayIso] = useState(""); // today as YYYY-MM-DD (set on the client)

  // --- Cloud sync (Supabase) ---
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const userId = user?.id ?? null; // stable across token refreshes; the user object is not
  const [cloudReady, setCloudReady] = useState(false); // initial pull+merge done
  const [syncStatus, setSyncStatus] = useState<
    "idle" | "syncing" | "synced" | "error"
  >("idle");
  const [email, setEmail] = useState(""); // sign-in email field
  const [authMsg, setAuthMsg] = useState(""); // feedback under the sign-in form
  const [notifying, setNotifying] = useState(false); // WhatsApp summary in flight
  const [notifyMsg, setNotifyMsg] = useState(""); // WhatsApp send feedback
  const [isOwner, setIsOwner] = useState(false); // signed in as the account owner?
  const [aiEnabled, setAiEnabled] = useState(false); // is live AI switched on server-side?
  const jobsRef = useRef<Job[]>([]); // always-current jobs, for use inside effects
  const lastSyncedRef = useRef<Map<string, string>>(new Map()); // id -> JSON last pushed

  // Demo mode (?demo=1): sample data, nothing saved or synced, canned AI results.
  const [demo, setDemo] = useState(false);

  // AI fit analysis
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null); // modal open for this job
  const [analyzingId, setAnalyzingId] = useState<string | null>(null); // request in flight
  const [aiMsg, setAiMsg] = useState(""); // last AI error, shown to the user

  // AI-assisted capture: the bookmarklet's payload, and how the cleanup is going.
  const [capture, setCapture] = useState<CapturePayload | null>(null);
  const [aiStatus, setAiStatus] = useState<"idle" | "working" | "done" | "failed">(
    "idle",
  );
  const [formContactsAi, setFormContactsAi] = useState<StoredContact[] | null>(
    null,
  );
  const captureRef = useRef<CapturePayload | null>(null); // the live capture, for stale-result checks
  const enrichedRef = useRef<CapturePayload | null>(null); // the capture already sent to the AI

  // Keep the always-current refs in step with state (refs must not be written
  // during render).
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);

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
  const [results, setResults] = useState<AdzunaJob[]>([]); // current page shown
  const [imported, setImported] = useState<Set<string>>(new Set());
  // Pagination
  const [sPage, setSPage] = useState(1);
  const [sTotal, setSTotal] = useState(0); // total results (or pool size for All Gulf)
  const [sPool, setSPool] = useState<AdzunaJob[]>([]); // whole merged list for All Gulf
  const [sPooled, setSPooled] = useState(false); // true when paging a local pool
  const [sSort, setSSort] = useState<"relevance" | "date">("relevance");

  // Load saved jobs once, when the page first opens (browser only). Reading
  // localStorage has to wait until after mount so the server-rendered HTML and the
  // first client render match — hence setState inside the effect.
  /* eslint-disable react-hooks/set-state-in-effect -- client-only state is hydrated after mount on purpose */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("demo") === "1") {
      // Demo mode: show sample data and never touch storage or the cloud. We
      // leave `loaded` false, which keeps the save and sync effects switched off.
      setDemo(true);
      setJobs(buildDemoJobs(new Date()));
      return;
    }
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
  /* eslint-enable react-hooks/set-state-in-effect */

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
        setIsOwner(false);
        setCloudReady(false);
        lastSyncedRef.current = new Map();
        setSyncStatus("idle");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // After sign-in, ask the server whether this account is the owner — WhatsApp
  // summaries go to the owner's phone, so only the owner sees that button.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const token = await getAccessToken();
      if (!token) return;
      try {
        const res = await fetch("/api/notify", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setIsOwner(res.ok && body.owner === true);
      } catch {
        if (!cancelled) setIsOwner(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // On sign-in: pull the user's jobs from the cloud and reconcile them with this
  // device's copy, then switch the board to the result. The rules (what to upload,
  // and what to drop because it was deleted on another device) live in
  // lib/syncMerge.ts and are covered by a two-device simulation test.
  useEffect(() => {
    if (!supabase || !userId || !loaded) return;
    let cancelled = false;
    (async () => {
      setSyncStatus("syncing");
      try {
        const result = await reconcileOnSignIn(
          jobsRef.current,
          jobCloud(userId),
          knownJobIds(userId),
        );
        if (cancelled) return;
        lastSyncedRef.current = result.snapshot;
        setJobs(result.jobs);
        setCloudReady(true);
        setSyncStatus("synced");
      } catch {
        if (!cancelled) setSyncStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, loaded]);

  // While signed in, push local changes to the cloud: upsert new/edited jobs and
  // delete removed ones, diffed against what we last pushed.
  useEffect(() => {
    if (!supabase || !userId || !cloudReady) return;
    const plan = planPush(jobs, lastSyncedRef.current);
    if (planIsEmpty(plan)) return;
    setSyncStatus("syncing");
    (async () => {
      try {
        lastSyncedRef.current = await pushChanges(
          jobs,
          plan,
          jobCloud(userId),
          knownJobIds(userId),
        );
        setSyncStatus("synced");
      } catch {
        setSyncStatus("error");
      }
    })();
  }, [jobs, userId, cloudReady]);

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

  // Send a job-summary WhatsApp on demand (uses your login token so only you
  // can trigger your own message).
  async function sendWhatsAppSummary() {
    if (!supabase) return;
    setNotifying(true);
    setNotifyMsg("");
    try {
      const token = await getAccessToken();
      if (!token) {
        setNotifyMsg("Please sign in again.");
        return;
      }
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      setNotifyMsg(
        res.ok && body.sent
          ? "Sent to your WhatsApp ✓"
          : `Couldn't send: ${body.detail || body.error || "unknown error"}`,
      );
    } catch {
      setNotifyMsg("Couldn't send the summary.");
    } finally {
      setNotifying(false);
    }
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
    if (view !== "jobs" || demo) return;
    let cancelled = false;
    (async () => {
      try {
        const map = new Map<string, CvMeta>();
        const local = await getAllCvs();
        for (const c of local)
          map.set(c.id, { id: c.id, name: c.name, role: c.role });
        // When signed in, also include CVs that live only in the cloud, so a job
        // attached to one on another device still shows its name here.
        if (supabase && user) {
          try {
            const remote = await fetchRemoteCvs();
            for (const r of remote)
              if (!map.has(r.id))
                map.set(r.id, { id: r.id, name: r.name, role: r.role });
          } catch {
            /* ignore remote CV fetch errors */
          }
        }
        if (!cancelled) setCvList([...map.values()]);
      } catch {
        if (!cancelled) setCvList([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, user, demo]);

  // If opened via the bookmarklet (URL has ?fh_ params), pre-fill and open the
  // Add-a-job form, then clean the URL so a refresh doesn't re-add the job.
  /* eslint-disable react-hooks/set-state-in-effect -- reads the URL once after mount */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") return;
    const title = params.get("fh_title");
    const url = params.get("fh_url");
    if (!title && !url) return;
    const captured: CapturePayload = {
      title: title ?? "",
      company: params.get("fh_company") ?? "",
      url: url ?? "",
      salary: params.get("fh_salary") ?? "",
      text: cleanCapturedNotes(params.get("fh_notes") ?? ""),
    };
    setForm({
      ...EMPTY_FORM,
      title: captured.title,
      company: captured.company,
      url: captured.url,
      salary: captured.salary,
      notes: captured.text,
    });
    setCapture(captured); // lets the AI tidy it up once we know who is signed in
    setView("jobs");
    setShowForm(true);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Ask the server once whether live AI is switched on (an API key is configured).
  // If not, the AI buttons stay hidden rather than showing ones that can only fail.
  useEffect(() => {
    fetch("/api/ai/status")
      .then((res) => res.json())
      .then((body) => setAiEnabled(body?.enabled === true))
      .catch(() => setAiEnabled(false));
  }, []);

  // AI cleanup of a captured job (signed-in users only). The pre-filled form is
  // already usable; when the AI answers we improve fields the user hasn't touched
  // and attach the verified, named contacts. Failures are silent — the capture
  // simply stays as the bookmarklet filled it.
  useEffect(() => {
    if (!capture || !user || !aiEnabled || enrichedRef.current === capture) return;
    enrichedRef.current = capture;
    (async () => {
      setAiStatus("working");
      const token = await getAccessToken();
      if (!token) {
        setAiStatus("idle");
        return;
      }
      const res = await requestExtraction(token, capture);
      if (captureRef.current !== capture) return; // saved or cancelled meanwhile
      if (!res.ok) {
        setAiStatus("failed");
        return;
      }
      const x = res.value;
      setForm((f) => ({
        ...f,
        title: f.title === capture.title && x.title ? x.title : f.title,
        company: f.company === capture.company && x.company ? x.company : f.company,
        country: f.country === EMPTY_FORM.country && x.country ? x.country : f.country,
        salary: f.salary === capture.salary && x.salary ? x.salary : f.salary,
        deadline: f.deadline || x.deadline,
      }));
      setFormContactsAi(x.contacts.length ? x.contacts : null);
      setAiStatus("done");
    })();
  }, [capture, user, aiEnabled]);

  const visible = useMemo(
    () => filterJobs(jobs, { country, query }),
    [jobs, country, query],
  );

  // Contacts shown in the add-job form: the AI's verified, named ones when we have
  // them, otherwise whatever the notes text yields.
  const formContacts = formContactsAi
    ? splitStoredContacts(formContactsAi)
    : extractContacts(form.notes);

  // One line telling the user what the AI is doing with a freshly captured job.
  const captureHint = !capture
    ? ""
    : aiStatus === "working"
      ? "✨ Cleaning this up with AI…"
      : aiStatus === "done"
        ? "✨ Cleaned up with AI — contacts and fields were checked against the posting."
        : aiStatus === "failed"
          ? "AI cleanup wasn't available this time, so the capture is shown as-is."
          : !user && syncEnabled && !demo && aiEnabled
            ? "💡 Sign in and AI will clean up captured jobs and spot named contacts."
            : "";

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
      contacts: formContactsAi ?? undefined,
    };
    setJobs((prev) => [job, ...prev]);
    resetForm();
    setShowForm(false);
  }

  // Clear the add-job form and any in-progress AI capture state.
  function resetForm() {
    setForm(EMPTY_FORM);
    setFormContactsAi(null);
    setCapture(null);
    setAiStatus("idle");
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

  // Set/clear a job's deadline and follow-up date (edited on the card). Empty
  // string clears the date. Changes sync to the cloud via the jobs sync effect.
  function setJobDates(id: string, deadline: string, followUpDate: string) {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === id
          ? {
              ...j,
              deadline: deadline || undefined,
              followUpDate: followUpDate || undefined,
            }
          : j,
      ),
    );
  }

  // --- AI fit analysis -----------------------------------------------------

  // Store an analysis on its job; it then syncs like any other job field.
  function saveAnalysis(jobId: string, analysis: StoredAnalysis) {
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, analysis } : j)),
    );
  }

  // Open a job's saved analysis, or run a fresh one if it has none yet.
  function analyzeJob(job: Job) {
    if (job.analysis) {
      setAiMsg("");
      setAnalysisJobId(job.id);
      return;
    }
    void runAnalysis(job);
  }

  async function runAnalysis(job: Job) {
    setAiMsg("");
    if (!job.cvId) {
      setAiMsg(
        "Attach a CV to this job first (use the CV dropdown on its card), then analyze.",
      );
      return;
    }
    setAnalyzingId(job.id);
    try {
      if (demo) {
        // No AI call in demo mode — show the canned sample after a short beat.
        await new Promise((resolve) => setTimeout(resolve, 700));
        saveAnalysis(job.id, demoAnalysis());
        setAnalysisJobId(job.id);
        return;
      }
      const token = await getAccessToken();
      if (!token) {
        setAiMsg("Please sign in to use AI features.");
        return;
      }
      // Who to address the outreach to: the AI-extracted contacts if we have
      // them, else the pattern-matched ones. A few are enough.
      const found = extractContacts(job.notes);
      const contacts = (
        job.contacts?.length
          ? job.contacts.map((c) => ({ name: c.name, role: c.role, value: c.value }))
          : [...found.emails, ...found.phones].map((c) => ({
              name: c.name,
              role: "",
              value: c.value,
            }))
      ).slice(0, 3);
      const res = await requestAnalysis(token, {
        title: job.title,
        company: job.company,
        description: job.notes,
        cvId: job.cvId,
        contacts,
      });
      if (!res.ok) {
        setAiMsg(res.message);
        return;
      }
      saveAnalysis(job.id, res.value);
      setAnalysisJobId(job.id);
    } finally {
      setAnalyzingId(null);
    }
  }

  // The job whose analysis modal is open, if any.
  const analysisJob = jobs.find((j) => j.id === analysisJobId);
  // CVs offered on job cards: samples in demo mode, the user's own otherwise.
  const cvsForCards = demo ? DEMO_CVS : cvList;
  // The analyze button needs live AI plus a signed-in user — or demo mode, which
  // shows canned sample results and works with no key at all.
  const canAnalyze = demo || (Boolean(user) && aiEnabled);

  // Ask our own /api/adzuna endpoint for real jobs, then show them.
  // Split "provider:value" into its two parts.
  function searchProviderAndValue() {
    const sep = sTarget.indexOf(":");
    return { provider: sTarget.slice(0, sep), value: sTarget.slice(sep + 1) };
  }

  async function doSearch(page: number) {
    setSearching(true);
    setSearchError("");
    try {
      const { provider, value } = searchProviderAndValue();
      let url: string;
      if (provider === "jooble") {
        // Jooble's Gulf data only resolves by COUNTRY, not city — so keep the
        // country as the location and fold any typed city into the keywords.
        const keywords = sWhere.trim()
          ? `${sWhat} ${sWhere.trim()}`.trim()
          : sWhat;
        url = `/api/jooble?${new URLSearchParams({
          what: keywords,
          location: value,
          page: String(page),
        }).toString()}`;
      } else {
        url = `/api/adzuna?${new URLSearchParams({
          country: value,
          what: sWhat,
          where: sWhere,
          page: String(page),
          sort: sSort,
        }).toString()}`;
      }
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        setSearchError(data.error || "Search failed. Please try again.");
        setResults([]);
        setSTotal(0);
        setSPool([]);
        setSPooled(false);
      } else if (data.pooled) {
        // "All Gulf": one merged pool we page through locally.
        const pool = data.results as AdzunaJob[];
        setSPool(pool);
        setSPooled(true);
        setSTotal(pool.length);
        setSPage(1);
        setResults(pool.slice(0, SEARCH_PAGE_SIZE));
      } else {
        // Single source: the server returns one page + a total count.
        setSPooled(false);
        setSPool([]);
        setResults(data.results as AdzunaJob[]);
        setSTotal(data.count ?? 0);
        setSPage(page);
      }
    } catch {
      setSearchError("Could not reach the search service.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    doSearch(1);
  }

  const searchTotalPages = Math.max(1, Math.ceil(sTotal / SEARCH_PAGE_SIZE));

  function goToSearchPage(n: number) {
    if (n < 1 || n > searchTotalPages || searching) return;
    if (sPooled) {
      setSPage(n);
      setResults(sPool.slice((n - 1) * SEARCH_PAGE_SIZE, n * SEARCH_PAGE_SIZE));
    } else {
      doSearch(n);
    }
  }

  // Copy a search result into your own board as a new job.
  function currentTargetLabel(): string {
    const { provider, value } = searchProviderAndValue();
    if (provider === "jooble") {
      // "ALL_GULF" isn't a single country — imported results fall back to "Other".
      return GULF_LOCATIONS.find((g) => g.location === value)?.label ?? "Other";
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

      {demo ? (
        <div className="mt-4 rounded-xl border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm text-zinc-200">
          👀 <strong>Demo mode</strong> — sample data, nothing here is saved.
          Open the first job and try <strong>✨ Analyze fit</strong>, search live
          jobs, or poke around.{" "}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full reload on purpose: demo mode is decided at page load */}
          <a href="/" className="font-medium text-accent underline">
            Exit demo
          </a>
        </div>
      ) : syncEnabled && (
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
              <div className="flex flex-wrap items-center gap-2">
                {isOwner && notifyMsg && (
                  <span className="text-xs text-zinc-400">{notifyMsg}</span>
                )}
                {isOwner && (
                  <button
                    onClick={sendWhatsAppSummary}
                    disabled={notifying}
                    title="Send a job summary to your WhatsApp"
                    className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5 disabled:opacity-50"
                  >
                    {notifying ? "Sending…" : "📲 WhatsApp me a summary"}
                  </button>
                )}
                <button
                  onClick={signOut}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5"
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-zinc-400">
                🔒 Saved on this device only.{" "}
                <span className="text-zinc-300">
                  Sign in to sync across devices:
                </span>{" "}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full reload on purpose: demo mode is decided at page load */}
                <a href="/?demo=1" className="text-accent underline">
                  or try the demo
                </a>
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

      {view === "cvs" && (demo ? <DemoCvs /> : <CvManager />)}

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
          {captureHint && (
            <p className="text-xs text-zinc-400 sm:col-span-2">{captureHint}</p>
          )}
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
                resetForm();
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
            onSubmit={onSearchSubmit}
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
                  <option value="jooble:ALL_GULF">🌍 All Gulf countries</option>
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
            <Field label="Sort (Adzuna only)">
              <select
                className={inputClass}
                value={sSort}
                onChange={(e) =>
                  setSSort(e.target.value as "relevance" | "date")
                }
              >
                <option value="relevance">Relevance</option>
                <option value="date">Newest first</option>
              </select>
            </Field>
            <div className="sm:col-span-4">
              <button
                type="submit"
                disabled={searching}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
              >
                {searching ? "Searching…" : "🔎 Search jobs"}
              </button>
            </div>
          </form>

          <p className="mt-3 text-xs text-zinc-500">
            Gulf countries search via Jooble — pick{" "}
            <strong>🌍 All Gulf countries</strong> to search them all at once;
            Australia, Singapore and Europe via Adzuna. Senior roles tend to
            cluster on page 1, so browse further pages, try specific titles
            (e.g. &ldquo;product manager&rdquo;), or set Sort to &ldquo;Newest
            first&rdquo; on Adzuna to surface more mid-level roles. Jooble has
            limited free Gulf data, so use the bookmarklet or Add a job for
            anything it misses.
          </p>

          {searchError && (
            <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {searchError}
            </p>
          )}

          {results.length > 0 && (
            <p className="mt-4 text-xs text-zinc-400">
              {sTotal.toLocaleString()} result{sTotal === 1 ? "" : "s"}
              {sPooled ? " across the Gulf" : ""} · page {sPage} of{" "}
              {searchTotalPages}
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

          {results.length > 0 && searchTotalPages > 1 && (
            <div className="mt-5 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => goToSearchPage(sPage - 1)}
                disabled={sPage <= 1 || searching}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="text-xs text-zinc-400">
                Page {sPage} of {searchTotalPages}
              </span>
              <button
                type="button"
                onClick={() => goToSearchPage(sPage + 1)}
                disabled={sPage >= searchTotalPages || searching}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </section>
      )}

      {aiMsg && !analysisJob && (
        <div className="mt-6 flex items-start justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-200">
          <span>✨ {aiMsg}</span>
          <button
            onClick={() => setAiMsg("")}
            aria-label="Dismiss"
            className="shrink-0 text-amber-300/70 transition hover:text-amber-200"
          >
            ✕
          </button>
        </div>
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
                      cvs={cvsForCards}
                      todayIso={todayIso}
                      canAnalyze={canAnalyze}
                      analyzing={analyzingId === job.id}
                      onMove={moveJob}
                      onDelete={deleteJob}
                      onAttach={attachCv}
                      onSetDates={setJobDates}
                      onAnalyze={analyzeJob}
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

      {analysisJob?.analysis && (
        <AnalysisModal
          key={analysisJob.id}
          job={analysisJob}
          analysis={analysisJob.analysis}
          busy={analyzingId === analysisJob.id}
          error={aiMsg}
          onRerun={() => void runAnalysis(analysisJob)}
          onClose={() => {
            setAnalysisJobId(null);
            setAiMsg("");
          }}
        />
      )}

      {!demo && <DataBackup />}
    </div>
  );
}
