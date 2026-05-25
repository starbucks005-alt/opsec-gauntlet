/* ─────────────────────────────────────────────────────────────────────────────
   tg-reid-press.js — Press Release Generator UI for Reid's office.

   Mirrors the tg-zara-post.js pattern. On success:

     1. Renders headline + release + rationale in the result panel (with
        copy buttons for the headline alone and the full release).
     2. Appends the release to the visitor's brief in sessionStorage.
     3. Adds a revision-log entry so the DOCX export captures it as
        deliverable content.
     4. Re-renders the brief panel on the page so the visitor sees it land.

   SessionStorage:
     tg_visitor_brief   - current draft (mutated when a release is generated)
     tg_visitor_name    - greeting / addressing
     tg_ep_revisions    - revision log (release appended here too)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const ENDPOINT = '/.netlify/functions/tg-reid-press';
  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 45000; // larger than Zara - press releases are longer outputs

  function ss(k){ try { return sessionStorage.getItem(k); } catch(_) { return null; } }
  function ssSet(k, v){ try { sessionStorage.setItem(k, v); } catch(_){} }
  function ssJson(k, fallback){
    const raw = ss(k);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch(_) { return fallback; }
  }

  function escapeHtml(s){
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Re-render the brief panel (same lightweight approach as tg-zara-post.js).
  function rerenderBriefPanel() {
    const briefEl = document.querySelector('[data-tg-office="brief"]');
    if (!briefEl) return;
    const brief = ss(KEY_BRIEF) || '';
    if (brief) {
      briefEl.textContent = brief;
      briefEl.removeAttribute('data-empty');
    } else {
      briefEl.textContent = 'No brief yet. Drop something in from the welcome modal.';
      briefEl.setAttribute('data-empty', 'true');
    }
  }

  // Treat the generated release as a pre-accepted append revision. Same
  // shape as tg-ep-chat.js writes when a visitor accepts a proposed
  // revision - keeps the DOCX exporter unchanged.
  function appendToBrief(release, meta) {
    const oldBrief = (ss(KEY_BRIEF) || '').trim();
    const header   = `[Press Release: ${meta.announcementLabel}] ${meta.headline}`;
    const block    = header + '\n\n' + release.trim();
    const newBrief = oldBrief ? (oldBrief + '\n\n' + block) : block;
    ssSet(KEY_BRIEF, newBrief);

    const revisions = ssJson(KEY_REVISIONS, []);
    revisions.push({
      ep_id:         'reid_callum',
      operation:     'append',
      section_label: `Press Release: ${meta.announcementLabel} - ${meta.headline.slice(0, 80)}`,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `Press release drafted for ${meta.announcementLabel}.`,
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  function readActivePill(group) {
    const active = group.querySelector('.zh-pill.is-active');
    return active ? active.dataset.value : '';
  }

  async function generate(form) {
    const angleEl       = form.querySelector('[data-rh="angle"]');
    const announcementG = form.querySelector('[data-rh="announcement"]');
    const submitBtn     = form.querySelector('[data-rh="generate"]');
    const resultEl      = form.querySelector('[data-rh="result"]');

    const announcement_type = readActivePill(announcementG);
    const headline_angle    = (angleEl.value || '').trim();

    if (!announcement_type) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Pick an announcement type first.</div>';
      return;
    }

    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal before drafting a release. Reid writes from the brief, not from scratch.</div>';
      return;
    }
    const name = (ss(KEY_NAME) || '').trim();

    submitBtn.disabled = true;
    const origLabel = submitBtn.textContent;
    submitBtn.textContent = 'Drafting...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">Reid is drafting your release. About 15-25 seconds.</div>';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ announcement_type, headline_angle, brief, name }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error('reid-press ' + resp.status + ' ' + text.slice(0, 200));
      }
      const data = await resp.json();
      const headline           = String(data.headline           || '').trim();
      const release            = String(data.release            || '').trim();
      const rationale          = String(data.rationale          || '').trim();
      const announcementLabel  = String(data.announcement_label || announcement_type).trim();

      if (!headline || !release) throw new Error('incomplete response');

      // Save to brief BEFORE rendering so the brief panel reflects the
      // new content while the visitor reads the release for the first time.
      appendToBrief(release, { headline, announcementLabel, rationale });

      resultEl.className = 'zh-result is-ready';
      resultEl.innerHTML = ''
        + '<div class="zh-result-meta">'
        +   '<span class="zh-result-platform">' + escapeHtml(announcementLabel) + '</span>'
        +   '<button type="button" class="zh-result-copy" data-rh="copy-headline">Copy headline</button>'
        +   '<button type="button" class="zh-result-copy" data-rh="copy-release">Copy release</button>'
        + '</div>'
        + '<div class="rh-headline">' + escapeHtml(headline) + '</div>'
        + '<pre class="zh-result-post" data-rh="release-text">' + escapeHtml(release) + '</pre>'
        + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '')
        + '<p class="zh-result-saved">Saved to your brief and revision log. Square-bracket placeholders ([NUMBER], [CUSTOMER], [INVESTOR], etc.) mark facts Reid did not have - fill those in before you wire the release.</p>';

      const copyHl = resultEl.querySelector('[data-rh="copy-headline"]');
      const copyRl = resultEl.querySelector('[data-rh="copy-release"]');
      if (copyHl) {
        copyHl.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(headline);
            copyHl.textContent = 'Copied';
            setTimeout(() => { copyHl.textContent = 'Copy headline'; }, 1800);
          } catch(_){}
        });
      }
      if (copyRl) {
        copyRl.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(headline + '\n\n' + release);
            copyRl.textContent = 'Copied';
            setTimeout(() => { copyRl.textContent = 'Copy release'; }, 1800);
          } catch(_){}
        });
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-reid-press]', msg);
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">' + (
        isTimeout
          ? 'Reid took too long. Try again, or refresh the page.'
          : 'Could not draft the release. Try again.'
      ) + '</div>';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origLabel;
    }
  }

  function wirePills(group) {
    group.addEventListener('click', (e) => {
      const pill = e.target.closest('.zh-pill');
      if (!pill || !group.contains(pill)) return;
      group.querySelectorAll('.zh-pill').forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');
    });
  }

  function init() {
    const form = document.querySelector('[data-rh="form"]');
    if (!form) return;
    const announcementGroup = form.querySelector('[data-rh="announcement"]');
    if (announcementGroup) wirePills(announcementGroup);
    const submitBtn = form.querySelector('[data-rh="generate"]');
    if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(form); });
    rerenderBriefPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
