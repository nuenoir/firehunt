"use client";

// The "CVs" tab: upload PDF/Word CVs, tag them by role, download or delete
// them. Files live in IndexedDB (see lib/cvStore.ts) — private to this browser.

import { useEffect, useState } from "react";
import {
  CV_ROLES,
  MAX_CV_BYTES,
  formatBytes,
  hasAcceptedExtension,
  roleLabel,
  type CvRole,
} from "@/lib/cvs";
import { deleteCv, getAllCvs, saveCv, type CvRecord } from "@/lib/cvStore";

export default function CvManager() {
  const [cvs, setCvs] = useState<CvRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [role, setRole] = useState<CvRole>("consulting"); // role for the next upload
  const [error, setError] = useState("");

  // Load saved CVs from the browser database once, on open.
  useEffect(() => {
    getAllCvs()
      .then((list) => {
        list.sort((a, b) => b.dateAdded.localeCompare(a.dateAdded)); // newest first
        setCvs(list);
      })
      .catch(() => setError("Could not open the CV store in this browser."))
      .finally(() => setLoaded(true));
  }, []);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError("");
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so the same file can be picked again later
    if (!file) return;
    if (!hasAcceptedExtension(file.name)) {
      setError("Please choose a PDF, DOC, or DOCX file.");
      return;
    }
    if (file.size > MAX_CV_BYTES) {
      setError("That file is larger than 10 MB. Please upload a smaller CV.");
      return;
    }
    const record: CvRecord = {
      id: crypto.randomUUID(),
      name: file.name,
      role,
      type: file.type,
      size: file.size,
      dateAdded: new Date().toISOString(),
      blob: file,
    };
    try {
      await saveCv(record);
      setCvs((prev) => [record, ...prev]);
    } catch {
      setError("Could not save the file. Your browser storage may be full.");
    }
  }

  async function changeRole(cv: CvRecord, newRole: CvRole) {
    const updated = { ...cv, role: newRole };
    try {
      await saveCv(updated);
      setCvs((prev) => prev.map((c) => (c.id === cv.id ? updated : c)));
    } catch {
      setError("Could not update the CV.");
    }
  }

  async function remove(cv: CvRecord) {
    try {
      await deleteCv(cv.id);
      setCvs((prev) => prev.filter((c) => c.id !== cv.id));
    } catch {
      setError("Could not delete the CV.");
    }
  }

  // Save the stored file to the user's computer with its original name.
  function download(cv: CvRecord) {
    const url = URL.createObjectURL(cv.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = cv.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-6">
      {/* Upload panel */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="text-lg font-semibold">Your CVs</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Upload a PDF or Word CV and tag it by the kind of role it is written
          for. Files are stored privately in this browser.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-zinc-300">Tag as</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as CvRole)}
              className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent/70"
            >
              {CV_ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="cursor-pointer rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90">
            + Upload CV
            <input
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleFile}
              className="hidden"
            />
          </label>
        </div>
        {error && (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
      </div>

      {/* CV list */}
      {loaded && cvs.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-zinc-500">
          No CVs yet. Upload your first one above.
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cvs.map((cv) => {
            const meta = CV_ROLES.find((r) => r.id === cv.role);
            return (
              <article
                key={cv.id}
                className="flex flex-col rounded-xl border border-white/10 bg-white/5 p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="break-all text-sm font-semibold text-zinc-100">
                    {cv.name}
                  </h3>
                  <button
                    onClick={() => remove(cv)}
                    aria-label="Delete CV"
                    title="Delete"
                    className="shrink-0 rounded p-1 text-zinc-500 transition hover:bg-white/10 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  <span
                    className={`rounded-full border px-2 py-0.5 ${meta?.accent ?? ""}`}
                  >
                    {roleLabel(cv.role)}
                  </span>
                  <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-300">
                    {formatBytes(cv.size)}
                  </span>
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <select
                    value={cv.role}
                    onChange={(e) => changeRole(cv, e.target.value as CvRole)}
                    className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-accent/70"
                  >
                    {CV_ROLES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => download(cv)}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Download ↓
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-zinc-600">
                  Added {new Date(cv.dateAdded).toLocaleDateString()}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
