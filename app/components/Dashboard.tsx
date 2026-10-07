import { STATUSES, jobStats, type Job, type JobStatus } from "@/lib/jobs";

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
export default function Dashboard({
  jobs,
  todayIso,
}: {
  jobs: Job[];
  todayIso: string;
}) {
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
