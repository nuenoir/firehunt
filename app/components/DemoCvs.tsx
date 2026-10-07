import { CV_ROLES, roleLabel } from "@/lib/cvs";
import { DEMO_CVS } from "@/lib/demo";

/** The CVs tab in demo mode: a read-only look at sample CVs (no uploads). */
export default function DemoCvs() {
  return (
    <div className="mt-6">
      <div className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="text-lg font-semibold">Your CVs</h2>
        <p className="mt-1 text-sm text-zinc-400">
          In the real app you upload a PDF or Word CV, tag it by the kind of role
          it is written for, and attach it to jobs. Uploads are turned off in the
          demo; these are samples.
        </p>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {DEMO_CVS.map((cv) => {
          const meta = CV_ROLES.find((r) => r.id === cv.role);
          return (
            <article
              key={cv.id}
              className="rounded-xl border border-white/10 bg-white/5 p-4"
            >
              <h3 className="break-all text-sm font-semibold text-zinc-100">
                {cv.name}
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                <span
                  className={`rounded-full border px-2 py-0.5 ${meta?.accent ?? ""}`}
                >
                  {roleLabel(cv.role)}
                </span>
                <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-400">
                  sample
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
