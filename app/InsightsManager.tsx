"use client";

// The "Insights" tab: your own research notes per company — how the interview
// goes and what it takes to succeed. Saved in this browser via localStorage.

import { useEffect, useMemo, useState } from "react";
import {
  filterInsights,
  INSIGHTS_STORAGE_KEY,
  type Insight,
} from "@/lib/insights";

const STORAGE_KEY = INSIGHTS_STORAGE_KEY;

const EMPTY_FORM = {
  company: "",
  role: "",
  country: "",
  interview: "",
  success: "",
  notes: "",
};

const inputClass =
  "rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-accent/70";

export default function InsightsManager() {
  const [items, setItems] = useState<Insight[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from localStorage after mount (keeps server and client renders identical)
      if (raw) setItems(JSON.parse(raw) as Insight[]);
    } catch {
      // ignore missing/corrupt data
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items, loaded]);

  const visible = useMemo(() => filterInsights(items, query), [items, query]);

  function setField<K extends keyof typeof form>(
    key: K,
    value: (typeof form)[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(it: Insight) {
    setForm({
      company: it.company,
      role: it.role,
      country: it.country,
      interview: it.interview,
      success: it.success,
      notes: it.notes,
    });
    setEditingId(it.id);
    setShowForm(true);
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.company.trim()) return;
    const now = new Date().toISOString();
    if (editingId) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === editingId
            ? { ...it, ...form, company: form.company.trim(), updatedAt: now }
            : it,
        ),
      );
    } else {
      const it: Insight = {
        id: crypto.randomUUID(),
        ...form,
        company: form.company.trim(),
        updatedAt: now,
      };
      setItems((prev) => [it, ...prev]);
    }
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  }

  function remove(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Company insights</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Your own research — what you learn from Glassdoor, Blind, Reddit,
            LinkedIn, or people you know. FireHunt cannot pull this
            automatically (those sites block it), so you capture it here. AI
            interview prep is coming in a later step.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90"
        >
          + Add company
        </button>
      </div>

      {/* Add / edit form */}
      {showForm && (
        <form
          onSubmit={save}
          className="mt-4 grid grid-cols-1 gap-4 rounded-xl border border-white/10 bg-white/5 p-5 sm:grid-cols-2"
        >
          <Field label="Company *">
            <input
              className={inputClass}
              value={form.company}
              onChange={(e) => setField("company", e.target.value)}
              placeholder="e.g. Bain & Company"
            />
          </Field>
          <Field label="Role / team">
            <input
              className={inputClass}
              value={form.role}
              onChange={(e) => setField("role", e.target.value)}
              placeholder="e.g. Associate Consultant"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Location">
              <input
                className={inputClass}
                value={form.country}
                onChange={(e) => setField("country", e.target.value)}
                placeholder="e.g. Dubai, UAE"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="How the interview goes">
              <textarea
                className={inputClass}
                rows={3}
                value={form.interview}
                onChange={(e) => setField("interview", e.target.value)}
                placeholder="Rounds, case studies, timelines, who you meet…"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="What it takes to succeed">
              <textarea
                className={inputClass}
                rows={3}
                value={form.success}
                onChange={(e) => setField("success", e.target.value)}
                placeholder="Skills, frameworks, red flags, what they reward…"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Notes & sources">
              <textarea
                className={inputClass}
                rows={3}
                value={form.notes}
                onChange={(e) => setField("notes", e.target.value)}
                placeholder="Links to Glassdoor/Blind/Reddit threads, referral contacts…"
              />
            </Field>
          </div>
          <div className="flex gap-3 sm:col-span-2">
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90"
            >
              {editingId ? "Save changes" : "Save insight"}
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(EMPTY_FORM);
                setEditingId(null);
                setShowForm(false);
              }}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Search */}
      {items.length > 0 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company or role…"
          className={`${inputClass} mt-4 w-full`}
        />
      )}

      {/* List */}
      {loaded && items.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-zinc-500">
          No insights yet. Add your first company above.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {visible.map((it) => (
            <article
              key={it.id}
              className="rounded-xl border border-white/10 bg-white/5 p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-zinc-100">
                    {it.company}
                  </h3>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                    {it.role && (
                      <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-300">
                        {it.role}
                      </span>
                    )}
                    {it.country && (
                      <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-300">
                        {it.country}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    onClick={() => openEdit(it)}
                    className="rounded px-2 py-1 text-xs text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(it.id)}
                    aria-label="Delete insight"
                    title="Delete"
                    className="rounded p-1 text-zinc-500 transition hover:bg-white/10 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <Section label="How the interview goes" text={it.interview} />
              <Section label="What it takes to succeed" text={it.success} />
              <Section label="Notes & sources" text={it.notes} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

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

/** A titled block of text — only rendered if there's something to show. */
function Section({ label, text }: { label: string; text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-300">
        {text}
      </p>
    </div>
  );
}
