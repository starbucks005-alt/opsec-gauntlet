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
    sourcing: {
      endpoint:       '/.netlify/functions/tg-arjun-sourcing',
      brieflabel:     'Sourcing Map',
      bodyForFetch:   () => ({}),
      render:         renderSourcing,
      formatForBrief: formatSourcingForBrief,
    },
    regulatory: {
      endpoint:       '/.netlify/functions/tg-arjun-regulatory',
      brieflabel:     'Regulatory Path',
      bodyForFetch:   () => ({}),
      render:         renderRegulatory,
      formatForBrief: formatRegulatoryForBrief,
    },
    prototype: {
      endpoint:       '/.netlify/functions/tg-arjun-prototype',
      brieflabel:     'Prototype Plan',
      bodyForFetch:   () => ({}),
      render:         renderPrototype,
      formatForBrief: formatPrototypeForBrief,
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

  // ── Sourcing Map ─────────────────────────────────────────────────────
  function renderSourcing(data) {
    const cats     = Array.isArray(data.categories) ? data.categories : [];
    const warnings = Array.isArray(data.critical_path_warnings) ? data.critical_path_warnings : [];
    const rationale = String(data.rationale || '');

    const catsHtml = cats.map(c => {
      const exHtml = (c.example_parts || []).map(p => '<span class="at-chip">' + escapeHtml(p) + '</span>').join('');
      const chanHtml = (c.sourcing_channels || []).map(ch => ''
        + '<article class="at-chan">'
        +   '<div class="at-chan-name">' + escapeHtml(ch.channel || '') + '</div>'
        +   '<p class="at-chan-best"><span class="wt-mini-label">Best for:</span> ' + escapeHtml(ch.best_for || '') + '</p>'
        +   '<p class="at-chan-gotcha"><span class="wt-mini-label">Gotcha:</span> ' + escapeHtml(ch.gotcha || '') + '</p>'
        + '</article>'
      ).join('');
      return ''
        + '<article class="at-cat">'
        +   '<h4 class="at-cat-name">' + escapeHtml(c.category_name || '') + '</h4>'
        +   (exHtml ? '<div class="at-cat-parts">' + exHtml + '</div>' : '')
        +   '<div class="at-chan-list">' + chanHtml + '</div>'
        + '</article>';
    }).join('');

    const warnsHtml = warnings.map(w => ''
      + '<article class="at-warn">'
      +   '<h4>' + escapeHtml(w.item || '') + '</h4>'
      +   '<p class="at-warn-risk"><span class="wt-mini-label">Risk:</span> ' + escapeHtml(w.risk || '') + '</p>'
      +   '<p class="at-warn-derisk"><span class="wt-mini-label">De-risk:</span> ' + escapeHtml(w.de_risk || '') + '</p>'
      + '</article>'
    ).join('');

    return ''
      + '<div class="rt-out-block"><div class="rt-out-label">Part categories and sourcing channels</div>'
      +   '<div class="at-cat-list">' + catsHtml + '</div></div>'
      + (warnsHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Critical-path warnings</div>'
            + '<div class="at-warn-list">' + warnsHtml + '</div></div>'
          : '')
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  function formatSourcingForBrief(data) {
    const lines = [];
    lines.push('PART CATEGORIES AND SOURCING CHANNELS');
    (data.categories || []).forEach(c => {
      lines.push(`  - ${c.category_name}`);
      if (Array.isArray(c.example_parts) && c.example_parts.length) {
        lines.push(`      Example parts: ${c.example_parts.join(', ')}`);
      }
      (c.sourcing_channels || []).forEach(ch => {
        lines.push(`      [Channel] ${ch.channel}`);
        if (ch.best_for) lines.push(`         Best for: ${ch.best_for}`);
        if (ch.gotcha)   lines.push(`         Gotcha:   ${ch.gotcha}`);
      });
    });
    if (Array.isArray(data.critical_path_warnings) && data.critical_path_warnings.length) {
      lines.push('');
      lines.push('CRITICAL-PATH WARNINGS');
      data.critical_path_warnings.forEach(w => {
        lines.push(`  - ${w.item}`);
        lines.push(`      Risk:    ${w.risk}`);
        lines.push(`      De-risk: ${w.de_risk}`);
      });
    }
    if (data.rationale) { lines.push(''); lines.push('NOTE'); lines.push(`  ${data.rationale}`); }
    return { plainText: lines.join('\n'), title: '' };
  }

  // ── Regulatory Path ──────────────────────────────────────────────────
  function renderRegulatory(data) {
    const cls       = data.classification || {};
    const routes    = Array.isArray(data.routes) ? data.routes : [];
    const labs      = Array.isArray(data.testing_labs) ? data.testing_labs : [];
    const know      = String(data.one_thing_to_know || '');
    const rationale = String(data.rationale || '');

    const clsHtml = cls.classification ? ''
      + '<div class="at-class">'
      +   '<div class="at-class-label">' + escapeHtml(cls.classification) + '</div>'
      +   '<span class="at-conf at-conf-' + escapeHtml(cls.confidence || 'medium') + '">' + escapeHtml((cls.confidence || 'medium').toUpperCase()) + ' confidence</span>'
      + '</div>' : '';

    const routesHtml = routes.map(r => ''
      + '<article class="at-route">'
      +   '<h4>' + escapeHtml(r.route_name || '') + '</h4>'
      +   '<p>' + escapeHtml(r.what_it_requires || '') + '</p>'
      +   '<div class="at-route-meta">'
      +     '<span><strong>Timeline:</strong> ' + escapeHtml(r.estimated_timeline || '-') + '</span>'
      +     '<span><strong>Cost:</strong> ' + escapeHtml(r.estimated_cost_range || '-') + '</span>'
      +   '</div>'
      +   '<p class="at-route-step"><span class="wt-mini-label">First step:</span> ' + escapeHtml(r.first_step || '') + '</p>'
      + '</article>'
    ).join('');

    const labsHtml = labs.map(l => ''
      + '<article class="at-lab">'
      +   '<h4>' + escapeHtml(l.lab_type || '') + '</h4>'
      +   '<p>' + escapeHtml(l.best_for || '') + '</p>'
      + '</article>'
    ).join('');

    return ''
      + (clsHtml ? '<div class="rt-out-block"><div class="rt-out-label">Classification</div>' + clsHtml + '</div>' : '')
      + (routesHtml ? '<div class="rt-out-block"><div class="rt-out-label">Routes</div><div class="at-route-list">' + routesHtml + '</div></div>' : '')
      + (labsHtml ? '<div class="rt-out-block"><div class="rt-out-label">Testing / certification lab types</div><div class="at-lab-list">' + labsHtml + '</div></div>' : '')
      + (know ? '<div class="rt-out-block"><div class="rt-out-label">One thing to know</div><div class="iv-gap">' + escapeHtml(know) + '</div></div>' : '')
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  function formatRegulatoryForBrief(data) {
    const lines = [];
    const cls = data.classification || {};
    if (cls.classification) {
      lines.push(`CLASSIFICATION: ${cls.classification}  (${(cls.confidence || 'medium').toUpperCase()} confidence)`);
      lines.push('');
    }
    if (Array.isArray(data.routes) && data.routes.length) {
      lines.push('ROUTES');
      data.routes.forEach(r => {
        lines.push(`  - ${r.route_name}`);
        lines.push(`      ${r.what_it_requires}`);
        lines.push(`      Timeline: ${r.estimated_timeline}  /  Cost: ${r.estimated_cost_range}`);
        lines.push(`      First step: ${r.first_step}`);
      });
      lines.push('');
    }
    if (Array.isArray(data.testing_labs) && data.testing_labs.length) {
      lines.push('TESTING / CERTIFICATION LAB TYPES');
      data.testing_labs.forEach(l => {
        lines.push(`  - ${l.lab_type}`);
        lines.push(`      ${l.best_for}`);
      });
      lines.push('');
    }
    if (data.one_thing_to_know) {
      lines.push('ONE THING TO KNOW');
      lines.push(`  ${data.one_thing_to_know}`);
      lines.push('');
    }
    if (data.rationale) { lines.push('NOTE'); lines.push(`  ${data.rationale}`); }
    return { plainText: lines.join('\n'), title: cls.classification || '' };
  }

  // ── Prototype Plan ───────────────────────────────────────────────────
  function renderPrototype(data) {
    const stages    = Array.isArray(data.prototype_stages) ? data.prototype_stages : [];
    const progress  = String(data.progression_note || '');
    const avoid     = String(data.one_thing_to_avoid || '');
    const rationale = String(data.rationale || '');

    const stagesHtml = stages.map(s => ''
      + '<article class="at-stage-card">'
      +   '<div class="at-stage-card-head">'
      +     '<span class="at-stage at-stage-' + escapeHtml(s.stage_name) + '">' + escapeHtml(s.stage_name) + '</span>'
      +     '<h4>' + escapeHtml(s.what_to_build || '') + '</h4>'
      +   '</div>'
      +   '<p class="at-stage-where"><span class="wt-mini-label">Where:</span> ' + escapeHtml(s.where_to_build || '') + '</p>'
      +   '<div class="at-stage-meta">'
      +     '<span><strong>Cost:</strong> ' + escapeHtml(s.estimated_cost || '-') + '</span>'
      +     '<span><strong>Time:</strong> ' + escapeHtml(s.estimated_time || '-') + '</span>'
      +   '</div>'
      +   '<p class="at-stage-learn"><span class="wt-mini-label">What you learn:</span> ' + escapeHtml(s.what_you_learn || '') + '</p>'
      + '</article>'
    ).join('');

    return ''
      + '<div class="rt-out-block"><div class="rt-out-label">Prototype stages (cheap to design-intent)</div>'
      +   '<div class="at-stage-card-list">' + stagesHtml + '</div></div>'
      + (progress ? '<div class="rt-out-block"><div class="rt-out-label">When to move to the next stage</div><div class="iv-gap">' + escapeHtml(progress) + '</div></div>' : '')
      + (avoid    ? '<div class="rt-out-block"><div class="rt-out-label">One thing to avoid</div><div class="ct-kill">' + escapeHtml(avoid) + '</div></div>' : '')
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  function formatPrototypeForBrief(data) {
    const lines = [];
    lines.push('PROTOTYPE STAGES');
    (data.prototype_stages || []).forEach(s => {
      lines.push(`  [${(s.stage_name || '').toUpperCase()}] ${s.what_to_build}`);
      lines.push(`      Where: ${s.where_to_build}`);
      lines.push(`      Cost:  ${s.estimated_cost}   Time: ${s.estimated_time}`);
      lines.push(`      What you learn: ${s.what_you_learn}`);
    });
    if (data.progression_note) {
      lines.push('');
      lines.push('WHEN TO MOVE TO THE NEXT STAGE');
      lines.push(`  ${data.progression_note}`);
    }
    if (data.one_thing_to_avoid) {
      lines.push('');
      lines.push('ONE THING TO AVOID');
      lines.push(`  ${data.one_thing_to_avoid}`);
    }
    if (data.rationale) { lines.push(''); lines.push('NOTE'); lines.push(`  ${data.rationale}`); }
    return { plainText: lines.join('\n'), title: '' };
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
    const loadingByTool = {
      manufacturing: { btn: 'Mapping...',   msg: 'Arjun is mapping the path. About 20-30 seconds.' },
      sourcing:      { btn: 'Sourcing...',  msg: 'Arjun is mapping your sourcing channels. About 20-30 seconds.' },
      regulatory:    { btn: 'Checking...',  msg: 'Arjun is checking the regulatory exposure. About 20-30 seconds.' },
      prototype:     { btn: 'Planning...',  msg: 'Arjun is staging your prototype plan. About 20-30 seconds.' },
    };
    const ld = loadingByTool[toolKey] || loadingByTool.manufacturing;
    submitBtn.textContent = ld.btn;
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">' + ld.msg + '</div>';

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
