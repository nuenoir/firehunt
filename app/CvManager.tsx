"use client";

// The "CVs" tab: upload PDF/Word CVs, tag them by role, download or delete them.
// Files live in this browser's IndexedDB (see lib/cvStore.ts). When you're
// signed in, they ALSO sync to Supabase Storage so they appear on every device;
// files you didn't upload here are downloaded on demand when you open them.

import { useEffect, useState } from "react";
import {
  CV_ROLES,
  MAX_CV_BYTES,
  formatBytes,
  hasAcceptedExtension,
  roleLabel,
  type CvRole,
} from "@/lib/cvs";
import {
  deleteCv,
  getAllCvs,
  getCv,
  saveCv,
  type CvRecord,
} from "@/lib/cvStore";
import { supabase } from "@/lib/supabase";
import { reconcileCvs } from "@/lib/syncMerge";
import { loadKnownIds, saveKnownIds } from "@/lib/syncKnown";
import {
  cvStoragePath,
  deleteRemoteCv,
  downloadRemoteCv,
  fetchRemoteCvs,
  updateRemoteCvRole,
  uploadRemoteCv,
} from "@/lib/cvsRemote";

// A CV as shown in the list. It may live locally (has the file here), in the
// cloud (path set), or both.
interface CvItem {
  id: string;
  name: string;
  role: CvRole;
  type: string;
  size: number;
  dateAdded: string;
  path?: string; // cloud storage path, when synced
  hasLocalBlob: boolean; // whether the file is in THIS browser
}

/** Record (or forget) that this device has synced a CV with the cloud, so a copy
 *  deleted on another device isn't mistaken for a new upload later. If there is no
 *  history yet, the next load builds it from scratch. */
function rememberCv(userId: string, id: string, synced: boolean) {
  const known = loadKnownIds("cvs", userId);
  if (known === null) return;
  if (synced) known.add(id);
  else known.delete(id);
  saveKnownIds("cvs", userId, known);
}

export default function CvManager() {
  const [items, setItems] = useState<CvItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [role, setRole] = useState<CvRole>("consulting"); // role for the next upload
  const [error, setError] = useState("");
  const [user, setUser] = useState<{ id: string } | null>(null);
  const [busyId, setBusyId] = useState(""); // a CV currently downloading

  // Track auth state so we know whether to sync. Only update when the user id
  // actually changes, so the load-and-migrate effect below doesn't re-run on
  // every auth event.
  useEffect(() => {
    if (!supabase) return;
    const apply = (id: string | undefined) =>
      setUser((prev) => (prev?.id === id ? prev : id ? { id } : null));
    supabase.auth.getUser().then(({ data }) => apply(data.user?.id));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) =>
      apply(session?.user?.id),
    );
    return () => sub.subscription.unsubscribe();
  }, []);

  // Load CVs: local ones always; when signed in, merge the cloud list and
  // migrate any local-only CVs up (a one-time upload).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoaded(false);
      try {
        const local = await getAllCvs();
        const localById = new Map(local.map((c) => [c.id, c]));

        if (supabase && user) {
          const remote = await fetchRemoteCvs();
          // Decide what is new here (upload) and what was deleted on another
          // device (remove the stale local copy) — see lib/syncMerge.ts.
          const plan = reconcileCvs(
            local.map((c) => c.id),
            remote.map((r) => r.id),
            loadKnownIds("cvs", user.id),
          );
          const toUpload = new Set(plan.uploadIds);
          for (const id of plan.dropLocalIds) {
            try {
              await deleteCv(id);
            } catch {
              /* a stale copy that can't be removed is harmless */
            }
          }
          const localOnly = local.filter((c) => toUpload.has(c.id));
          const uploaded: string[] = [];
          for (const c of localOnly) {
            try {
              await uploadRemoteCv({
                userId: user.id,
                id: c.id,
                name: c.name,
                role: c.role,
                type: c.type,
                size: c.size,
                dateAdded: c.dateAdded,
                blob: c.blob,
              });
              uploaded.push(c.id);
            } catch {
              /* keep going; it stays available locally and retries next time */
            }
          }
          // Remember what is now in sync (failed uploads are left out to retry).
          saveKnownIds("cvs", user.id, [...remote.map((r) => r.id), ...uploaded]);
          const map = new Map<string, CvItem>();
          for (const r of remote) {
            map.set(r.id, {
              id: r.id,
              name: r.name,
              role: r.role,
              type: r.type,
              size: r.size,
              dateAdded: r.dateAdded,
              path: r.path,
              hasLocalBlob: localById.has(r.id),
            });
          }
          for (const c of localOnly) {
            map.set(c.id, {
              id: c.id,
              name: c.name,
              role: c.role,
              type: c.type,
              size: c.size,
              dateAdded: c.dateAdded,
              path: cvStoragePath(user.id, c.id),
              hasLocalBlob: true,
            });
          }
          const union = [...map.values()].sort((a, b) =>
            b.dateAdded.localeCompare(a.dateAdded),
          );
          if (!cancelled) setItems(union);
        } else {
          const localItems: CvItem[] = local
            .map((c) => ({
              id: c.id,
              name: c.name,
              role: c.role,
              type: c.type,
              size: c.size,
              dateAdded: c.dateAdded,
              hasLocalBlob: true,
            }))
            .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
          if (!cancelled) setItems(localItems);
        }
      } catch {
        if (!cancelled) setError("Could not load your CVs.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

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
      await saveCv(record); // always keep a local copy
      let path: string | undefined;
      if (supabase && user) {
        path = await uploadRemoteCv({
          userId: user.id,
          id: record.id,
          name: record.name,
          role: record.role,
          type: record.type,
          size: record.size,
          dateAdded: record.dateAdded,
          blob: file,
        });
        rememberCv(user.id, record.id, true);
      }
      const item: CvItem = {
        id: record.id,
        name: record.name,
        role: record.role,
        type: record.type,
        size: record.size,
        dateAdded: record.dateAdded,
        path,
        hasLocalBlob: true,
      };
      setItems((prev) => [item, ...prev]);
    } catch {
      setError(
        "Could not save the file. Your browser storage may be full, or the upload failed.",
      );
    }
  }

  async function changeRole(item: CvItem, newRole: CvRole) {
    try {
      if (item.hasLocalBlob) {
        const rec = await getCv(item.id);
        if (rec) await saveCv({ ...rec, role: newRole });
      }
      if (supabase && user && item.path) {
        await updateRemoteCvRole(item.id, newRole);
      }
      setItems((prev) =>
        prev.map((c) => (c.id === item.id ? { ...c, role: newRole } : c)),
      );
    } catch {
      setError("Could not update the CV.");
    }
  }

  async function remove(item: CvItem) {
    try {
      if (item.hasLocalBlob) await deleteCv(item.id);
      if (supabase && user && item.path) {
        await deleteRemoteCv(item.id, item.path);
        rememberCv(user.id, item.id, false);
      }
      setItems((prev) => prev.filter((c) => c.id !== item.id));
    } catch {
      setError("Could not delete the CV.");
    }
  }

  // Save the file to the user's computer — from the local copy if we have it,
  // otherwise downloaded from the cloud (and cached locally for next time).
  async function download(item: CvItem) {
    setError("");
    setBusyId(item.id);
    try {
      let blob: Blob | undefined;
      if (item.hasLocalBlob) {
        blob = (await getCv(item.id))?.blob;
      }
      if (!blob && item.path && supabase) {
        blob = await downloadRemoteCv(item.path);
        try {
          await saveCv({
            id: item.id,
            name: item.name,
            role: item.role,
            type: item.type,
            size: item.size,
            dateAdded: item.dateAdded,
            blob,
          });
          setItems((prev) =>
            prev.map((c) =>
              c.id === item.id ? { ...c, hasLocalBlob: true } : c,
            ),
          );
        } catch {
          /* caching is best-effort */
        }
      }
      if (!blob) {
        setError("Could not find that file.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Could not download the CV.");
    } finally {
      setBusyId("");
    }
  }

  const syncing = Boolean(supabase && user);

  return (
    <div className="mt-6">
      {/* Upload panel */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="text-lg font-semibold">Your CVs</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Upload a PDF or Word CV and tag it by the kind of role it is written
          for.{" "}
          {syncing
            ? "You're signed in, so your CVs sync across your devices ☁"
            : "Files are stored privately in this browser — sign in to sync them across devices."}
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
      {loaded && items.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-zinc-500">
          No CVs yet. Upload your first one above.
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((cv) => {
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
                  {syncing && cv.path && (
                    <span
                      className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-zinc-400"
                      title={
                        cv.hasLocalBlob
                          ? "Synced and saved on this device"
                          : "In the cloud — downloads when you open it"
                      }
                    >
                      {cv.hasLocalBlob ? "☁ synced" : "☁ cloud"}
                    </span>
                  )}
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
                    disabled={busyId === cv.id}
                    className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                  >
                    {busyId === cv.id ? "Downloading…" : "Download ↓"}
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
