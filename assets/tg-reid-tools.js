/* ─────────────────────────────────────────────────────────────────────────────
   tg-reid-tools.js — SEO / Brand / Pitch generators for Reid's office.

   Three tools share one client because their plumbing (form -> fetch ->
   render -> append-to-brief -> revision-log) is identical. Each tool has
   its own card in the office HTML (data-rt-tool="seo"|"brand"|"pitch"),
   its own endpoint, and its own renderer.

   Press release generator stays in tg-reid-press.js (already shipped).
   This file adds the three follow-ups on top.

   SessionStorage:
     tg_visitor_brief   - mutated when a generator returns
     tg_visitor_name    - greeting
     tg_ep_revisions    - revision log (each generated artifact appended)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 40000;

  // Per-tool config: endpoint, label for the brief header, and the
  // renderer that turns the JSON response into HTML for the result panel.
  // Each renderer ALSO returns a plain-text block that gets appended to
  // the visitor's brief so the DOCX export captures the deliverable.
  const TOOLS = {
    seo: {
      endpoint:     '/.netlify/functions/tg-reid-seo',
      brieflabel:   'SEO Starter Kit',
      bodyForFetch: (form) => ({}),                   // no extra inputs
      render:       renderSeo,
      formatForBrief: formatSeoForBrief,
    },
    brand: {
      endpoint:     '/.netlify/functions/tg-reid-brand',
      brieflabel:   'Brand Direction',
      bodyForFetch: (form) => ({}),
      render:       renderBrand,
      formatForBrief: formatBrandForBrief,
    },
    pitch: {
      endpoint:     '/.netlify/functions/tg-reid-pitch',
      brieflabel:   'Media Pitch',
      bodyForFetch: (form) => {
        const beat  = (form.querySelector('[data-rt="beat"]')  || {}).value || '';
        const angle = (form.querySelector('[data-rt="angle"]') || {}).value || '';
        return { journalist_beat: beat.trim(), pitch_angle: angle.trim() };
      },
      render:       renderPitch,
      formatForBrief: formatPitchForBrief,
    },
  };

  // ── sessionStorage helpers ────────────────────────────────────────────
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

  function appendToBrief(plainText, meta) {
    const oldBrief = (ss(KEY_BRIEF) || '').trim();
    const header   = `[${meta.brieflabel}] ${meta.title || ''}`.trim();
    const block    = header + '\n\n' + plainText.trim();
    const newBrief = oldBrief ? (oldBrief + '\n\n' + block) : block;
    ssSet(KEY_BRIEF, newBrief);

    const revisions = ssJson(KEY_REVISIONS, []);
    revisions.push({
      ep_id:         'reid_callum',
      operation:     'append',
      section_label: meta.title ? `${meta.brieflabel}: ${String(meta.title).slice(0, 80)}` : meta.brieflabel,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `${meta.brieflabel} drafted by Reid.`,
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  // ── Renderers (one per tool) ──────────────────────────────────────────

  function renderSeo(data) {
    const kws = Array.isArray(data.target_keywords) ? data.target_keywords : [];
    const checklist = Array.isArray(data.on_page_checklist) ? data.on_page_checklist : [];
    const meta = String(data.meta_description || '');
    const rationale = String(data.rationale || '');

    const kwHtml = kws.map(k => ''
      + '<div class="rt-kw">'
      +   '<span class="rt-kw-text">' + escapeHtml(k.keyword || '') + '</span>'
      +   '<span class="rt-kw-tag">' + escapeHtml((k.type || '').replace('_', '-')) + '</span>'
      +   '<span class="rt-kw-tag rt-kw-intent">' + escapeHtml(k.intent || '') + '</span>'
      + '</div>'
    ).join('');

    const checkHtml = checklist.map(item =>
      '<li>' + escapeHtml(item) + '</li>'
    ).join('');

    return ''
      + '<div class="rt-out-block"><div class="rt-out-label">Target Keywords</div>'
      +   '<div class="rt-kw-list">' + kwHtml + '</div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Meta Description</div>'
      +   '<div class="rt-meta-desc">' + escapeHtml(meta) + ' <span class="rt-meta-count">(' + meta.length + ' chars)</span></div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">On-Page Checklist</div>'
      +   '<ul class="rt-check-list">' + checkHtml + '</ul></div>'
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }
  function formatSeoForBrief(data) {
    const lines = [];
    lines.push('TARGET KEYWORDS');
    (data.target_keywords || []).forEach(k => {
      lines.push(`  - ${k.keyword} [${(k.type || '').replace('_', '-')}, ${k.intent || ''}]`);
    });
    lines.push('');
    lines.push('META DESCRIPTION');
    lines.push(`  ${data.meta_description || ''}`);
    lines.push('');
    lines.push('ON-PAGE CHECKLIST');
    (data.on_page_checklist || []).forEach(item => lines.push(`  - ${item}`));
    if (data.rationale) { lines.push(''); lines.push('NOTE'); lines.push(`  ${data.rationale}`); }
    return { plainText: lines.join('\n'), title: '' };
  }

  function renderBrand(data) {
    const fonts   = Array.isArray(data.fonts) ? data.fonts : [];
    const logo    = Array.isArray(data.logo_direction) ? data.logo_direction : [];
    const palette = Array.isArray(data.palette) ? data.palette : [];
    const tones   = Array.isArray(data.tone_descriptors) ? data.tone_descriptors : [];
    const rationale = String(data.rationale || '');

    const fontsHtml = fonts.map(f =>
      '<div class="rt-font">'
      + '<div class="rt-font-pair">' + escapeHtml(f.pair || '') + '</div>'
      + '<div class="rt-font-reason">' + escapeHtml(f.reason || '') + '</div>'
      + '</div>'
    ).join('');

    const logoHtml = logo.map(d => '<li>' + escapeHtml(d) + '</li>').join('');

    const paletteHtml = palette.map(c => ''
      + '<div class="rt-swatch">'
      +   '<div class="rt-swatch-chip" style="background:' + escapeHtml(c.hex) + '"></div>'
      +   '<div class="rt-swatch-meta">'
      +     '<div class="rt-swatch-hex">' + escapeHtml(c.hex) + '</div>'
      +     '<div class="rt-swatch-name">' + escapeHtml(c.name || '') + '</div>'
      +     '<div class="rt-swatch-role">' + escapeHtml(c.role || '') + '</div>'
      +   '</div>'
      + '</div>'
    ).join('');

    const toneHtml = tones.map(t => '<span class="rt-tone-chip">' + escapeHtml(t) + '</span>').join('');

    return ''
      + '<div class="rt-out-block"><div class="rt-out-label">Fonts</div>' + fontsHtml + '</div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Logo Direction</div><ul class="rt-check-list">' + logoHtml + '</ul></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Color Palette</div><div class="rt-palette">' + paletteHtml + '</div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Tone Descriptors</div><div class="rt-tones">' + toneHtml + '</div></div>'
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }
  function formatBrandForBrief(data) {
    const lines = [];
    lines.push('FONTS');
    (data.fonts || []).forEach(f => lines.push(`  - ${f.pair}  (${f.reason || ''})`));
    lines.push('');
    lines.push('LOGO DIRECTION');
    (data.logo_direction || []).forEach(d => lines.push(`  - ${d}`));
    lines.push('');
    lines.push('PALETTE');
    (data.palette || []).forEach(c => lines.push(`  - ${c.hex}  ${c.name || ''}  (${c.role || ''})`));
    lines.push('');
    lines.push('TONE');
    lines.push(`  ${(data.tone_descriptors || []).join(', ')}`);
    if (data.rationale) { lines.push(''); lines.push('NOTE'); lines.push(`  ${data.rationale}`); }
    return { plainText: lines.join('\n'), title: '' };
  }

  function renderPitch(data) {
    const subject = String(data.subject_line || '');
    const body    = String(data.email_body || '');
    const rationale = String(data.rationale || '');
    return ''
      + '<div class="rt-out-block"><div class="rt-out-label">Subject</div>'
      +   '<div class="rt-pitch-subject">' + escapeHtml(subject) + '</div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Body</div>'
      +   '<pre class="zh-result-post">' + escapeHtml(body) + '</pre></div>'
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }
  function formatPitchForBrief(data) {
    const lines = [];
    lines.push(`SUBJECT: ${data.subject_line || ''}`);
    lines.push('');
    lines.push(data.email_body || '');
    if (data.rationale) { lines.push(''); lines.push(`NOTE: ${data.rationale}`); }
    return { plainText: lines.join('\n'), title: data.subject_line || '' };
  }

  // ── Generate (shared) ─────────────────────────────────────────────────
  async function generate(form, toolKey) {
    const cfg = TOOLS[toolKey];
    if (!cfg) return;

    const submitBtn = form.querySelector('[data-rt="generate"]');
    const resultEl  = form.querySelector('[data-rt="result"]');

    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal first. Reid works from the brief.</div>';
      return;
    }
    const name = (ss(KEY_NAME) || '').trim();

    // Tool-specific inputs (only pitch has any).
    const extraBody = cfg.bodyForFetch(form);
    if (toolKey === 'pitch' && !extraBody.journalist_beat) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Tell Reid which journalist beat you are pitching (e.g., "AI infrastructure", "indie pharmacy operations").</div>';
      const beatEl = form.querySelector('[data-rt="beat"]');
      if (beatEl) beatEl.focus();
      return;
    }

    submitBtn.disabled = true;
    const origLabel = submitBtn.textContent;
    submitBtn.textContent = 'Drafting...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">Reid is drafting. About 10-20 seconds.</div>';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ brief, name }, extraBody)),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(toolKey + ' ' + resp.status + ' ' + text.slice(0, 200));
      }
      const data = await resp.json();

      // Save to brief first, then render. Brief panel reflects the new
      // section while the visitor reads the rendered result.
      const formatted = cfg.formatForBrief(data);
      appendToBrief(formatted.plainText, {
        brieflabel: cfg.brieflabel,
        title:      formatted.title,
        rationale:  data.rationale,
      });

      resultEl.className = 'zh-result is-ready';
      resultEl.innerHTML = ''
        + '<div class="zh-result-meta">'
        +   '<span class="zh-result-platform">' + escapeHtml(cfg.brieflabel) + '</span>'
        + '</div>'
        + cfg.render(data)
        + '<p class="zh-result-saved">Saved to your brief and revision log. It will export in your deliverable.</p>';
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-reid-tools:' + toolKey + ']', msg);
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">' + (
        isTimeout
          ? 'Reid took too long. Try again, or refresh the page.'
          : 'Could not draft. Try again.'
      ) + '</div>';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origLabel;
    }
  }

  // ── Init: wire each tool form by its data-rt-tool ─────────────────────
  function init() {
    document.querySelectorAll('[data-rt-tool]').forEach(form => {
      const toolKey = form.getAttribute('data-rt-tool');
      if (!TOOLS[toolKey]) return;
      const submitBtn = form.querySelector('[data-rt="generate"]');
      if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(form, toolKey); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
