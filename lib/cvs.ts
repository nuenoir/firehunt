// lib/cvs.ts
// Pure types + helpers for CVs. No React, no browser APIs here.

export type CvRole = "consulting" | "tech" | "strategy" | "general";

export interface CvRoleMeta {
  id: CvRole;
  label: string;
  /** Tailwind classes for the role pill. */
  accent: string;
}

// The role each CV version is tailored for.
export const CV_ROLES: CvRoleMeta[] = [
  {
    id: "consulting",
    label: "Consulting",
    accent: "text-sky-300 border-sky-400/30 bg-sky-400/10",
  },
  {
    id: "tech",
    label: "Tech",
    accent: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10",
  },
  {
    id: "strategy",
    label: "Strategy",
    accent: "text-violet-300 border-violet-400/30 bg-violet-400/10",
  },
  {
    id: "general",
    label: "General",
    accent: "text-amber-300 border-amber-400/30 bg-amber-400/10",
  },
];

export const ACCEPTED_CV_EXTENSIONS = [".pdf", ".doc", ".docx"];
export const MAX_CV_BYTES = 10 * 1024 * 1024; // 10 MB

export function roleLabel(id: CvRole): string {
  return CV_ROLES.find((r) => r.id === id)?.label ?? id;
}

/** Human-friendly file size, e.g. "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** True if the file name ends in an accepted CV extension. */
export function hasAcceptedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_CV_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
