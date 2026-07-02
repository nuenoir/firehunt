"use client";

// Shows a draggable "bookmarklet" — a browser bookmark whose address is a tiny
// piece of JavaScript. When clicked on a job page (LinkedIn, Prosple, etc.) it
// reads the page title + URL (and any text you've highlighted) and opens
// FireHunt with those details pre-filled in the Add-a-job form.

import { useEffect, useRef, useState } from "react";

export default function Bookmarklet() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);

  // Build the bookmarklet once, baking in THIS FireHunt address so it keeps
  // working if you later move FireHunt to a real web address.
  useEffect(() => {
    const origin = window.location.origin;
    const bm =
      "javascript:(function(){" +
      "var d=document,t=d.title||'',u=location.href;" +
      "var s=(window.getSelection&&String(window.getSelection()))||'';" +
      "var m=d.querySelector('meta[property=\"og:site_name\"]');" +
      "var c=m?m.content:'';" +
      "var b=" +
      JSON.stringify(origin) +
      "+'/?fh_title='+encodeURIComponent(t)+'&fh_company='+encodeURIComponent(c)+'&fh_url='+encodeURIComponent(u)+'&fh_notes='+encodeURIComponent(s);" +
      "window.open(b,'_blank');" +
      "})();";
    setCode(bm);
  }, []);

  // React refuses to render javascript: hrefs, so set it straight on the DOM.
  useEffect(() => {
    if (linkRef.current && code) linkRef.current.setAttribute("href", code);
  }, [code]);

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
            {/* href is set via the ref above (React blocks javascript: links) */}
            <a
              ref={linkRef}
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
              On any job page, optionally highlight the description, then click
              the bookmark. FireHunt opens with the job pre-filled — review and
              hit Save.
            </li>
          </ol>

          <p className="mt-4 text-xs text-zinc-500">
            It grabs the page title, web address, and any text you highlighted
            (as notes). You fill in the rest. Safe to use — you are just reading
            a page you already opened, not scraping.
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
