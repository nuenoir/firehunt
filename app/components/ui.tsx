// Shared styling and tiny presentational helpers used across the app.

// Shared styling for text inputs / selects so they all look the same.
export const inputClass =
  "rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-accent/70";

/** A labelled form field wrapper. */
export function Field({
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

/** Shown when there are no jobs saved yet. */
export function EmptyState({ onAdd }: { onAdd: () => void }) {
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
