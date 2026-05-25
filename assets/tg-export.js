/* ─────────────────────────────────────────────────────────────────────────────
   tg-export.js — client-side hook for the "Export brief" button.

   Loaded by every EP office page and by report.html. Any element with
   [data-tg-export] triggers the export on click:

     <button data-tg-export>Export brief &darr;</button>

   On click:
     1. Read brief + original + revisions + name + title from sessionStorage.
     2. POST to /.netlify/functions/tg-export-docx.
     3. The function returns a DOCX blob with the current brief, the
        revision log, and the original brief appended.
     4. Trigger a browser download.

   No analytics, no server-side bookkeeping. The export is the visitor's
   copy — it goes to their disk and nothing else changes. SessionStorage
   is untouched.

   sessionStorage keys consumed:
     tg_visitor_brief          - current draft (post-revisions)
     tg_visitor_brief_orig     - frozen original brief
     tg_ep_revisions           - JSON array of accepted revisions
     tg_visitor_name           - visitor first name
     tg_submission_title       - title set by the intake form (optional)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const ENDPOINT = '/.netlify/functions/tg-export-docx';

  function ss(k){ try { return sessionStorage.getItem(k); } catch(_) { return null; } }
  function ssJson(k, fallback){
    const raw = ss(k);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch(_) { return fallback; }
  }

  function buildPayload() {
    return {
      brief:     (ss('tg_visitor_brief')      || '').trim(),
      original:  (ss('tg_visitor_brief_orig') || '').trim(),
      revisions: ssJson('tg_ep_revisions', []),
      name:      (ss('tg_visitor_name')       || '').trim(),
      title:     (ss('tg_submission_title')   || '').trim(),
    };
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      btn.dataset.tgExportPrev = btn.textContent;
      btn.textContent = 'Building…';
      btn.disabled = true;
    } else {
      btn.disabled = false;
      if (btn.dataset.tgExportPrev) {
        btn.textContent = btn.dataset.tgExportPrev;
        delete btn.dataset.tgExportPrev;
      }
    }
  }

  function setError(btn, msg) {
    if (!btn) return;
    btn.dataset.tgExportPrev = btn.dataset.tgExportPrev || btn.textContent;
    btn.textContent = msg || 'Export failed';
    btn.disabled = false;
    setTimeout(() => {
      if (btn.dataset.tgExportPrev) {
        btn.textContent = btn.dataset.tgExportPrev;
        delete btn.dataset.tgExportPrev;
      }
    }, 3500);
  }

  function safeFilename(name, title) {
    const cleanName  = String(name  || 'gauntlet').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'gauntlet';
    const cleanTitle = String(title || 'brief').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brief';
    return `${cleanName}-${cleanTitle}.docx`;
  }

  async function exportBrief(btn) {
    const payload = buildPayload();
    if (!payload.brief) {
      setError(btn, 'No brief to export');
      return;
    }
    setBusy(btn, true);

    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn('[tg-export]', err && err.message);
      setError(btn, 'Network error');
      return;
    }

    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = j && j.error; } catch(_) {}
      console.warn('[tg-export] http', resp.status, detail);
      setError(btn, 'Export failed');
      return;
    }

    let blob;
    try { blob = await resp.blob(); }
    catch (err) {
      console.warn('[tg-export] blob', err && err.message);
      setError(btn, 'Export failed');
      return;
    }

    // Honor the filename the server proposed if present, else fall back.
    let filename = safeFilename(payload.name, payload.title);
    const cd = resp.headers && resp.headers.get && resp.headers.get('Content-Disposition');
    if (cd) {
      const m = cd.match(/filename="?([^"]+)"?/i);
      if (m && m[1]) filename = m[1];
    }

    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    setBusy(btn, false);
  }

  // Event delegation - catches both static buttons (office pages) AND
  // dynamically-rendered buttons (report.html injects its Export button
  // after the evaluation payload renders, well after DOMContentLoaded).
  function onDelegatedClick(e) {
    const btn = e.target && e.target.closest && e.target.closest('[data-tg-export]');
    if (!btn) return;
    e.preventDefault();
    exportBrief(btn);
  }

  function init() {
    document.addEventListener('click', onDelegatedClick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
