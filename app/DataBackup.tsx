"use client";

// Export everything (jobs, CVs, notes) to one backup file, and restore it
// later — so nothing is lost if this browser's data gets cleared, or you move
// to another computer.

import { useRef, useState } from "react";
import { JOBS_STORAGE_KEY } from "@/lib/jobs";
import { INSIGHTS_STORAGE_KEY } from "@/lib/insights";
import { clearAllCvs, getAllCvs, saveCv, type CvRecord } from "@/lib/cvStore";

// Read a file (CV) into a base64 text form so it can live inside JSON.
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export default function DataBackup() {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    setBusy(true);
    setMsg("");
    try {
      const cvs = await getAllCvs();
      const cvExports = await Promise.all(
        cvs.map(async (c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          type: c.type,
          size: c.size,
          dateAdded: c.dateAdded,
          dataUrl: await blobToDataUrl(c.blob),
        })),
      );
      const backup = {
        app: "firehunt",
        version: 1,
        exportedAt: new Date().toISOString(),
        jobs: JSON.parse(localStorage.getItem(JOBS_STORAGE_KEY) || "[]"),
        insights: JSON.parse(localStorage.getItem(INSIGHTS_STORAGE_KEY) || "[]"),
        cvs: cvExports,
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `firehunt-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg("Backup downloaded.");
    } catch {
      setMsg("Could not create the backup.");
    } finally {
      setBusy(false);
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again later
    if (!file) return;
    const ok = window.confirm(
      "Restoring will REPLACE your current jobs, CVs, and notes with the backup. Continue?",
    );
    if (!ok) return;
    setBusy(true);
    setMsg("");
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== "firehunt" || !Array.isArray(data.jobs)) {
        setMsg("That does not look like a FireHunt backup file.");
        setBusy(false);
        return;
      }
      localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(data.jobs ?? []));
      localStorage.setItem(
        INSIGHTS_STORAGE_KEY,
        JSON.stringify(data.insights ?? []),
      );
      await clearAllCvs();
      for (const c of data.cvs ?? []) {
        const blob = await (await fetch(c.dataUrl)).blob();
        const record: CvRecord = {
          id: c.id,
          name: c.name,
          role: c.role,
          type: c.type,
          size: c.size,
          dateAdded: c.dateAdded,
          blob,
        };
        await saveCv(record);
      }
      // Reload so every tab re-reads the restored data.
      window.location.reload();
    } catch {
      setMsg("Could not read that backup file.");
      setBusy(false);
    }
  }

  return (
    <footer className="mt-10 border-t border-white/10 pt-6">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-zinc-300">Backup</span>
        <button
          onClick={handleExport}
          disabled={busy}
          className="rounded-lg border border-white/15 px-3 py-1.5 font-medium text-zinc-200 transition hover:bg-white/5 disabled:opacity-50"
        >
          Download backup
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded-lg border border-white/15 px-3 py-1.5 font-medium text-zinc-200 transition hover:bg-white/5 disabled:opacity-50"
        >
          Restore from file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportFile}
          className="hidden"
        />
        {msg && <span className="text-xs text-zinc-500">{msg}</span>}
      </div>
      <p className="mt-2 text-xs text-zinc-600">
        Saves all your jobs, CVs, and notes to one file. Everything lives in this
        browser only — download a backup now and then, or to move to another
        computer.
      </p>
    </footer>
  );
}
