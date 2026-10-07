"use client";

import { useState } from "react";
import type { Contact } from "@/lib/contacts";

/** A single contact pill you can click to copy (text stays selectable too).
 *  Shows a person name in front of the value when one is known. */
function ContactChip({
  icon,
  value,
  name,
}: {
  icon: string;
  value: string;
  name?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; the text is still selectable to copy by hand
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={name ? `Click to copy ${value} (${name})` : `Click to copy ${value}`}
      className="max-w-full cursor-copy select-text truncate rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-accent transition hover:bg-accent/20"
    >
      {copied ? (
        "Copied ✓"
      ) : (
        <>
          {icon} {name && <span className="font-semibold">{name} · </span>}
          {value}
        </>
      )}
    </button>
  );
}

/** Click-to-copy email / phone chips, shared by the add-job form and job cards. */
export default function ContactChips({
  emails,
  phones,
}: {
  emails: Contact[];
  phones: Contact[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {emails.map((e) => (
        <ContactChip key={e.value} icon="✉" value={e.value} name={e.name} />
      ))}
      {phones.map((p) => (
        <ContactChip key={p.value} icon="☎" value={p.value} name={p.name} />
      ))}
    </div>
  );
}
