/* ─────────────────────────────────────────────────────────────────────────────
   tg-zara-post.js — Founder Post Generator UI for Zara's office.

   Wires the generator block (topic input + platform pills + tone pills +
   Generate button) to the tg-zara-post Netlify function. On success:

     1. Renders the post in the result panel (with rationale + copy button).
     2. Appends the post to the visitor's brief in sessionStorage.
     3. Adds a revision-log entry (so DOCX export captures the post in
        the deliverable, same shape as the EP-revision pattern).
     4. Re-renders the brief panel on the page so the visitor sees the
        update immediately.

   No HTML changes are made beyond the result panel - the office layout
   stays as the EP-corridor convention.

   SessionStorage:
     tg_visitor_brief   - current draft (mutated when a post is generated)
     tg_visitor_name    - greeting / addressing
     tg_ep_revisions    - revision log (the post gets appended here too)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const ENDPOINT = '/.netlify/functions/tg-zara-post';
  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 30000;

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

  // Re-render the brief panel. tg-ep-chat.js owns the canonical render for
  // its own purposes; this is a minimal duplicate so the generator does
  // not depend on private state inside that script.
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

  // Same shape as tg-ep-chat.js writes to the revision log when the
  // visitor accepts a proposed revision. Treating a generated post as a
  // pre-accepted append revision is what keeps it inside the DOCX export.
  function appendToBrief(postText, meta) {
    const oldBrief = (ss(KEY_BRIEF) || '').trim();
    const header   = `[Content: ${meta.platformLabel} - ${meta.toneLabel}] ${meta.topic}`;
    const block    = header + '\n\n' + postText.trim();
    const newBrief = oldBrief ? (oldBrief + '\n\n' + block) : block;
    ssSet(KEY_BRIEF, newBrief);

    const revisions = ssJson(KEY_REVISIONS, []);
    revisions.push({
      ep_id:         'zara_cole',
      operation:     'append',
      section_label: `Content: ${meta.platformLabel} - ${meta.toneLabel} - ${meta.topic.slice(0, 60)}`,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `Founder post drafted for ${meta.platformLabel} in ${meta.toneLabel} tone.`,
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
    const topicEl    = form.querySelector('[data-zh="topic"]');
    const platformEl = form.querySelector('[data-zh="platform"]');
    const toneEl     = form.querySelector('[data-zh="tone"]');
    const submitBtn  = form.querySelector('[data-zh="generate"]');
    const resultEl   = form.querySelector('[data-zh="result"]');

    const topic    = (topicEl.value || '').trim();
    const platform = readActivePill(platformEl);
    const tone     = readActivePill(toneEl);

    if (!topic) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Pick a topic first. One sentence is enough.</div>';
      topicEl.focus();
      return;
    }

    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal before generating posts. Zara writes from the brief, not from scratch.</div>';
      return;
    }
    const name = (ss(KEY_NAME) || '').trim();

    submitBtn.disabled = true;
    const origLabel = submitBtn.textContent;
    submitBtn.textContent = 'Drafting...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">Zara is writing your post. About 10 seconds.</div>';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, platform, tone, brief, name }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error('zara-post ' + resp.status + ' ' + text.slice(0, 200));
      }
      const data = await resp.json();
      const post           = String(data.post || '').trim();
      const rationale      = String(data.rationale || '').trim();
      const platformLabel  = String(data.platform_label || platform).trim();
      const toneLabel      = String(data.tone_label || tone).trim();

      if (!post) throw new Error('empty post in response');

      // Save to brief BEFORE rendering so the brief panel reflects the
      // new content while the visitor reads the post for the first time.
      appendToBrief(post, { topic, platformLabel, toneLabel, rationale });

      resultEl.className = 'zh-result is-ready';
      resultEl.innerHTML = ''
        + '<div class="zh-result-meta">'
        +   '<span class="zh-result-platform">' + escapeHtml(platformLabel) + '</span>'
        +   '<span class="zh-result-tone">' + escapeHtml(toneLabel) + '</span>'
        +   '<button type="button" class="zh-result-copy" data-zh="copy">Copy</button>'
        + '</div>'
        + '<pre class="zh-result-post" data-zh="post-text">' + escapeHtml(post) + '</pre>'
        + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '')
        + '<p class="zh-result-saved">Saved to your brief and revision log. It will export in your deliverable.</p>';

      const copyBtn = resultEl.querySelector('[data-zh="copy"]');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(post);
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
          } catch(_){}
        });
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-zara-post]', msg);
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">' + (
        isTimeout
          ? 'Zara took too long. Try again, or refresh the page.'
          : 'Could not draft the post. Try again.'
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
    const form = document.querySelector('[data-zh="form"]');
    if (!form) return;
    const platformGroup = form.querySelector('[data-zh="platform"]');
    const toneGroup     = form.querySelector('[data-zh="tone"]');
    if (platformGroup) wirePills(platformGroup);
    if (toneGroup)     wirePills(toneGroup);
    const submitBtn = form.querySelector('[data-zh="generate"]');
    if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(form); });

    // Make sure the brief panel reflects the current sessionStorage value
    // on first paint (in case the user lands on this page from a deep link).
    rerenderBriefPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
