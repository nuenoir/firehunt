"use client";

// Shows a draggable "bookmarklet" — a browser bookmark whose address is a tiny
// piece of JavaScript. When clicked on a job page (LinkedIn, Prosple, etc.) it
// reads the page title + URL (and any text you've highlighted) and opens
// FireHunt with those details pre-filled in the Add-a-job form.
// The bookmarklet itself is built in lib/bookmarklet.ts.

import { useMemo, useState } from "react";
import { buildBookmarklet } from "@/lib/bookmarklet";

export default function Bookmarklet() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Bake in THIS FireHunt address so the bookmark keeps working wherever the
  // app is hosted. (Empty during server rendering; the panel only shows after a
  // click, so nothing rendered depends on it.)
  const code = useMemo(
    () =>
      typeof window === "undefined"
        ? ""
        : buildBookmarklet(window.location.origin),
    [],
  );

  // React refuses to render javascript: hrefs, so set it straight on the DOM.
  // A callback ref runs when the link mounts (i.e. when the panel is opened).
  function setLinkRef(el: HTMLAnchorElement | null) {
    if (el && code) el.setAttribute("href", code);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be blocked; the drag method still works
    }
  }

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/5"
      >
        {open ? "Hide bookmarklet" : "📌 Get the job-capture bookmarklet"}
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-5 text-sm text-zinc-300">
          <p className="font-medium text-zinc-100">
            Drag this button up to your browser&apos;s bookmarks bar:
          </p>
          <div className="mt-3">
            {/* href is set via the callback ref (React blocks javascript: links) */}
            <a
              ref={setLinkRef}
              onClick={(e) => e.preventDefault()}
              className="inline-block cursor-grab rounded-lg bg-accent px-4 py-2 font-semibold text-black active:cursor-grabbing"
              title="Drag me to your bookmarks bar"
            >
              🔥 Save to FireHunt
            </a>
          </div>

          <ol className="mt-4 list-decimal space-y-1 pl-5 text-zinc-400">
            <li>
              Make sure your bookmarks bar is visible (Ctrl+Shift+B in most
              browsers).
            </li>
            <li>Drag the orange button above onto that bar.</li>
            <li>
              On a job page, just <strong>click the bookmark</strong> &mdash;
              FireHunt opens pre-filled with the title, company, the
              &ldquo;About the job&rdquo; text, and any email or phone contacts
              found in it. If a stubborn site still comes up blank, highlight the
              description first and then click. Review and hit Save.
            </li>
          </ol>

          <p className="mt-4 text-xs text-zinc-500">
            It reads the job&apos;s details straight from the page — title,
            company, salary, location, the full &ldquo;About the job&rdquo;
            text, and any email or phone contacts hidden in that description (so
            you can reach out directly instead of just Easy-Applying). Works on
            LinkedIn, Indeed and many others. You review and fill any gaps. Safe
            to use — it only reads a page you already opened, not scraping.
          </p>

          <button
            onClick={copy}
            className="mt-4 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5"
          >
            {copied ? "Copied ✓" : "Or copy the code (to paste into a bookmark)"}
          </button>
        </div>
      )}
    </div>
  );
}
