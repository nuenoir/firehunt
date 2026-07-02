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
    // The bookmarklet runs on the job page you're viewing. It first tries to
    // read the site's hidden "JobPosting" data (JSON-LD, used by LinkedIn,
    // Indeed, Glassdoor and many career sites for Google) to get clean title,
    // company, salary and location. If that's missing, it falls back to the
    // page's Open Graph / <title> tags so it never comes back empty.
    const bm =
      "javascript:(function(){" +
      "var d=document,u=location.href;" +
      "var sel=(window.getSelection&&String(window.getSelection()).trim())||'';" +
      "var t='',c='',sal='',loc='',desc='';" +
      "function nm(x){return x==null?'':(typeof x==='object'?(x.name||''):x);}" +
      // --- 1) Try structured JobPosting data (works across most job boards) ---
      "try{var S=d.querySelectorAll('script[type=\"application/ld+json\"]');" +
      "for(var i=0;i<S.length&&!t;i++){var data;try{data=JSON.parse(S[i].textContent);}catch(e){continue;}" +
      "var arr=Array.isArray(data)?data:(data['@graph']||[data]);" +
      "for(var j=0;j<arr.length;j++){var o=arr[j];if(!o||o['@type']!=='JobPosting')continue;" +
      "t=o.title||'';c=nm(o.hiringOrganization);" +
      "var bs=o.baseSalary;if(bs){var v=bs.value||bs;var cur=bs.currency||v.currency||'';" +
      "var amt=v.value||(v.minValue&&v.maxValue?v.minValue+'-'+v.maxValue:(v.minValue||v.maxValue||''));" +
      "var un=v.unitText?(' / '+String(v.unitText).toLowerCase()):'';" +
      "if(amt)sal=(cur?cur+' ':'')+amt+un;}" +
      "var jl=o.jobLocation;if(jl){var L=Array.isArray(jl)?jl[0]:jl;var a=(L&&L.address)?L.address:L;" +
      "if(a)loc=[nm(a.addressLocality),nm(a.addressRegion),nm(a.addressCountry)].filter(Boolean).join(', ');}" +
      "desc=o.description||'';break;}}}catch(e){}" +
      // --- 2) Fallbacks for title/company when JobPosting data is missing ---
      "if(!t){var ot=d.querySelector('meta[property=\"og:title\"]');t=(ot&&ot.content)||'';}" +
      // Many sites bake job + employer into the page title, e.g. LinkedIn's
      // 'Job Title | Company | LinkedIn'. Split it to recover both.
      "if((!t||!c)&&d.title&&d.title.indexOf(' | ')>-1){var sg=d.title.split(' | ').map(function(x){return x.trim();}).filter(Boolean);" +
      "if(sg.length>1&&/^(linkedin|indeed|glassdoor|seek|bayt|gulftalent|naukrigulf|monster|ziprecruiter)$/i.test(sg[sg.length-1]))sg.pop();" +
      "if(!t&&sg[0])t=sg[0];if(!c&&sg[1])c=sg[1];}" +
      "if(!c){var os=d.querySelector('meta[property=\"og:site_name\"]');if(os&&os.content&&!/^(linkedin|indeed|glassdoor)$/i.test(os.content))c=os.content;}" +
      "if(!t)t=d.title||'';" +
      // --- 3) Full 'About the job' text: from JobPosting HTML, else from the page's description box ---
      "var body='';" +
      "if(desc){var h=desc.replace(/<(br|\\/p|\\/li|\\/h[1-6]|\\/div)[^>]*>/gi,'\\n');var tmp=d.createElement('div');tmp.innerHTML=h;body=tmp.textContent||'';}" +
      "if(!body){var el=d.querySelector('#job-details,.jobs-description__content,.jobs-box__html-content,.jobs-description-content__text,.show-more-less-html__markup,.description__text');if(el&&(el.innerText||'').length>80)body=el.innerText||el.textContent||'';}" +
      // LinkedIn hides the description from the tags above, so recover it from the visible
      // 'About the job' section and trim the unrelated listings that follow it.
      "if(!body){var bt=(d.body&&d.body.innerText)||'';var mi=bt.search(/About the job|Job description|About this job|Role overview/i);if(mi>-1){var tail=bt.slice(mi);var st=tail.search(/\\n(Similar jobs|People also viewed|More jobs|Jobs you may be interested in|See more jobs|Set alert)/i);if(st>0)tail=tail.slice(0,st);body=tail;}}" +
      "body=body.replace(/[ \\t]+/g,' ').replace(/\\n[ \\t]+/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,5000);" +
      // --- 4) Pull email / phone contacts out of the description so you can reach out directly ---
      "function uq(a){var o={},r=[];for(var i=0;i<a.length;i++){var k=(a[i]||'').trim();if(k&&!o[k]){o[k]=1;r.push(k);}}return r;}" +
      "var blob=body+'\\n'+sel;" +
      "var em=uq(blob.match(/[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}/g)||[]);" +
      "var ph=uq((blob.match(/(\\+\\d[\\d ().\\-]{6,}\\d)|(\\b0\\d[\\d ().\\-]{7,}\\d)/g)||[]).filter(function(p){var g=p.replace(/\\D/g,'');return g.length>=8&&g.length<=15;}));" +
      "var contact='';if(em.length)contact+='Email: '+em.join(', ');if(ph.length)contact+=(contact?'\\n':'')+'Phone: '+ph.join(', ');" +
      // --- 5) Assemble notes: contacts first, then location, then the description (or your highlight) ---
      "var main=body;if(sel&&(!main||main.indexOf(sel)===-1))main=sel+(main?'\\n\\n---\\n\\n'+main:'');" +
      "var parts=[];if(contact)parts.push(contact);if(loc)parts.push('Location: '+loc);if(main)parts.push(main);" +
      "var notes=parts.join('\\n\\n');" +
      "var b=" +
      JSON.stringify(origin) +
      "+'/?fh_title='+encodeURIComponent(t)+'&fh_company='+encodeURIComponent(c)+'&fh_url='+encodeURIComponent(u)+'&fh_salary='+encodeURIComponent(sal)+'&fh_notes='+encodeURIComponent(notes);" +
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
