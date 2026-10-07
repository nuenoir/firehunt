"use client";

import { useState } from "react";
import {
  STATUSES,
  dueStatus,
  type DueStatus,
  type Job,
  type JobStatus,
} from "@/lib/jobs";
import { roleLabel, type CvMeta } from "@/lib/cvs";
import { extractContacts, splitStoredContacts } from "@/lib/contacts";
import ContactChips from "@/app/components/ContactChips";

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

/** A single job card shown inside a board column. */
export default function JobCard({
  job,
  cvs,
  todayIso,
  canAnalyze,
  analyzing,
  onMove,
  onDelete,
  onAttach,
  onSetDates,
  onAnalyze,
}: {
  job: Job;
  cvs: CvMeta[];
  todayIso: string;
  canAnalyze: boolean;
  analyzing: boolean;
  onMove: (id: string, status: JobStatus) => void;
  onDelete: (id: string) => void;
  onAttach: (jobId: string, cvId: string) => void;
  onSetDates: (id: string, deadline: string, followUpDate: string) => void;
  onAnalyze: (job: Job) => void;
}) {
  const [editDates, setEditDates] = useState(false);
  // Only treat a CV as attached if it still exists in the list.
  const attachedId =
    job.cvId && cvs.some((c) => c.id === job.cvId) ? job.cvId : "";
  // Contacts shown up front so you don't have to scroll the notes: the AI's
  // verified, named contacts when we have them, else the pattern-matched ones.
  const contacts = job.contacts?.length
    ? splitStoredContacts(job.contacts)
    : extractContacts(job.notes);
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

      <div className="mt-2">
        <button
          onClick={() => setEditDates((v) => !v)}
          className="text-[11px] text-zinc-500 transition hover:text-zinc-300"
        >
          {editDates
            ? "Hide dates"
            : job.deadline || job.followUpDate
              ? "✎ Edit dates"
              : "📅 Add deadline / follow-up"}
        </button>
        {editDates && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
              Deadline
              <input
                type="date"
                value={job.deadline ?? ""}
                onChange={(e) =>
                  onSetDates(job.id, e.target.value, job.followUpDate ?? "")
                }
                className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-accent/70"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
              Follow-up
              <input
                type="date"
                value={job.followUpDate ?? ""}
                onChange={(e) =>
                  onSetDates(job.id, job.deadline ?? "", e.target.value)
                }
                className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-accent/70"
              />
            </label>
          </div>
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

      {canAnalyze && (
        <button
          onClick={() => onAnalyze(job)}
          disabled={analyzing}
          title={
            attachedId
              ? "Compare your attached CV with this job"
              : "Attach a CV first, then analyze"
          }
          className="mt-2 w-full rounded-md border border-accent/40 bg-accent/10 px-2 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/20 disabled:opacity-50"
        >
          {analyzing
            ? "✨ Analyzing…"
            : job.analysis
              ? `✨ Fit ${job.analysis.fit_score}/100 · view`
              : "✨ Analyze fit"}
        </button>
      )}

      <p className="mt-2 text-[11px] text-zinc-600">
        Added {new Date(job.dateAdded).toLocaleDateString()}
      </p>
    </article>
  );
}
