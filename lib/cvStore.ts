// lib/cvStore.ts
// BROWSER-ONLY. This module stores CV files in IndexedDB (a small database
// built into the browser). It's kept separate from the pure lib/cvs.ts because
// it touches a browser API. All functions here only run in the browser — they
// are called from click handlers and effects, never during server rendering.

import type { CvRole } from "./cvs";

export interface CvRecord {
  id: string;
  name: string; // original file name
  role: CvRole;
  type: string; // MIME type, e.g. "application/pdf"
  size: number; // bytes
  dateAdded: string; // ISO date string
  blob: Blob; // the actual file contents
}

const DB_NAME = "firehunt";
const STORE = "cvs";
const VERSION = 1;

// Open (or create) the browser database. Returns a ready-to-use connection.
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Add a new CV, or overwrite an existing one with the same id (used for edits).
export async function saveCv(record: CvRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getAllCvs(): Promise<CvRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      db.close();
      resolve(req.result as CvRecord[]);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deleteCv(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// Remove all stored CVs. Used when restoring a backup (replace, not merge).
export async function clearAllCvs(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
