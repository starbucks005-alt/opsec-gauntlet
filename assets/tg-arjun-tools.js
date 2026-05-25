/* ─────────────────────────────────────────────────────────────────────────────
   tg-arjun-tools.js — Manufacturing Roadmap generator for Arjun's office.

   Mirrors the tg-reid-tools.js pattern: form -> fetch -> render ->
   append-to-brief -> revision-log. Single tool right now (manufacturing
   roadmap). Sourcing Map / Regulatory Path / Prototype Plan generators
   are queued for follow-up slices and can drop into this file then.

   SessionStorage:
     tg_visitor_brief   - mutated when the roadmap returns
     tg_visitor_name    - greeting
     tg_ep_revisions    - revision log (roadmap appended here)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 45000;

  const TOOLS = {
    manufacturing: {
      endpoint:       '/.netlify/functions/tg-arjun-manufacturing',
      brieflabel:     'Manufacturing Roadmap',
      bodyForFetch:   () => ({}),
      render:         renderManufacturing,
      formatForBrief: formatManufacturingForBrief,
    },
  };

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
      ep_id:         'arjun_mehta',
      operation:     'append',
      section_label: meta.title ? `${meta.brieflabel}: ${String(meta.title).slice(0, 80)}` : meta.brieflabel,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `${meta.brieflabel} drafted by Arjun.`,
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  // ── Renderer for the manufacturing roadmap ────────────────────────────
  function renderManufacturing(data) {
    const category   = String(data.product_category || '');
    const approaches = Array.isArray(data.approach_options) ? data.approach_options : [];
    const shapes     = Array.isArray(data.manufacturer_shapes) ? data.manufacturer_shapes : [];
    const questions  = Array.isArray(data.questions_to_ask) ? data.questions_to_ask : [];
    const rationale  = String(data.rationale || '');

    const approachHtml = approaches.map(o => ''
      + '<article class="at-approach">'
      +   '<div class="at-approach-head">'
      +     '<span class="at-stage at-stage-' + escapeHtml((o.stage || '').toLowerCase()) + '">' + escapeHtml((o.stage || '').replace('_', ' ')) + '</span>'
      +     '<span class="at-approach-name">' + escapeHtml(o.name || '') + '</span>'
      +   '</div>'
      +   '<p class="at-approach-when">' + escapeHtml(o.when_it_fits || '') + '</p>'
      +   '<div class="at-approach-meta">'
      +     '<span><strong>MOQ:</strong> ' + escapeHtml(o.est_moq || '-') + '</span>'
      +     '<span><strong>Lead time:</strong> ' + escapeHtml(o.est_lead_time || '-') + '</span>'
      +   '</div>'
      + '</article>'
    ).join('');

    const shapesHtml = shapes.map(s => ''
      + '<article class="at-shape">'
      +   '<div class="at-shape-head">'
      +     '<h4>' + escapeHtml(s.shape || '') + '</h4>'
      +     '<span class="at-shape-region">' + escapeHtml(s.region || '') + '</span>'
      +   '</div>'
      +   '<p>' + escapeHtml(s.why || '') + '</p>'
      + '</article>'
    ).join('');

    const questionsHtml = questions.map(q => '<li>' + escapeHtml(q) + '</li>').join('');

    return ''
      + '<div class="rt-out-block"><div class="rt-out-label">Product category</div>'
      +   '<div class="at-category">' + escapeHtml(category) + '</div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Approach options (early stage to scale)</div>'
      +   '<div class="at-approach-list">' + approachHtml + '</div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Manufacturer shapes to look for</div>'
      +   '<div class="at-shape-list">' + shapesHtml + '</div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Questions to ask on the first call</div>'
      +   '<ul class="rt-check-list">' + questionsHtml + '</ul></div>'
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  function formatManufacturingForBrief(data) {
    const lines = [];
    lines.push(`PRODUCT CATEGORY: ${data.product_category || ''}`);
    lines.push('');
    lines.push('APPROACH OPTIONS');
    (data.approach_options || []).forEach(o => {
      lines.push(`  - [${(o.stage || '').toUpperCase()}] ${o.name}`);
      lines.push(`      ${o.when_it_fits}`);
      lines.push(`      MOQ: ${o.est_moq}  /  Lead time: ${o.est_lead_time}`);
    });
    lines.push('');
    lines.push('MANUFACTURER SHAPES TO LOOK FOR');
    (data.manufacturer_shapes || []).forEach(s => {
      lines.push(`  - ${s.shape}  (${s.region})`);
      lines.push(`      ${s.why}`);
    });
    lines.push('');
    lines.push('QUESTIONS TO ASK ON THE FIRST CALL');
    (data.questions_to_ask || []).forEach(q => lines.push(`  - ${q}`));
    if (data.rationale) { lines.push(''); lines.push('NOTE'); lines.push(`  ${data.rationale}`); }
    return { plainText: lines.join('\n'), title: data.product_category || '' };
  }

  async function generate(form, toolKey) {
    const cfg = TOOLS[toolKey];
    if (!cfg) return;

    const submitBtn = form.querySelector('[data-at="generate"]');
    const resultEl  = form.querySelector('[data-at="result"]');

    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal first. Arjun works from the brief.</div>';
      return;
    }
    const name = (ss(KEY_NAME) || '').trim();

    submitBtn.disabled = true;
    const origLabel = submitBtn.textContent;
    submitBtn.textContent = 'Mapping...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">Arjun is mapping the path. About 20-25 seconds.</div>';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ brief, name }, cfg.bodyForFetch(form))),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(toolKey + ' ' + resp.status + ' ' + text.slice(0, 200));
      }
      const data = await resp.json();

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
        + '<p class="zh-result-saved">Saved to your brief and revision log. The manufacturer shapes are SEARCH TERMS - paste each shape into Google or ThomasNet to find specific CMs in that region.</p>';
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-arjun-tools:' + toolKey + ']', msg);
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">' + (
        isTimeout
          ? 'Arjun took too long. Try again, or refresh the page.'
          : 'Could not build the roadmap. Try again.'
      ) + '</div>';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origLabel;
    }
  }

  function init() {
    document.querySelectorAll('[data-at-tool]').forEach(form => {
      const toolKey = form.getAttribute('data-at-tool');
      if (!TOOLS[toolKey]) return;
      const submitBtn = form.querySelector('[data-at="generate"]');
      if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(form, toolKey); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
