/* ─────────────────────────────────────────────────────────────────────────────
   tg-wren-tools.js — Landscape Scout Report generator for Wren's office.

   Mirrors the tg-carol-tools / tg-arjun-tools / tg-matthew-tools pattern.
   Renders the full landscape map with distinct sections for:
     - Where it can work (segments with density chips)
     - Focus recommendation (highlighted beachhead card)
     - Other Uses (the SLR-Studio insight - same mechanic, different domain)
     - Adjacent moves (small product pivots)
     - White space map (verdict chips: opportunity / caution / graveyard)
     - Search hooks (monospace search strings + database label)

   SessionStorage: tg_visitor_brief, tg_visitor_name, tg_ep_revisions.
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 45000;

  const TOOLS = {
    scout: {
      endpoint:       '/.netlify/functions/tg-wren-scout',
      brieflabel:     'Landscape Scout Report',
      bodyForFetch:   () => ({}),
      render:         renderScout,
      formatForBrief: formatScoutForBrief,
    },
    patent: {
      // Two-phase: queries endpoint runs LLM-driven query extraction
      // and the SerpAPI patent search; analyze endpoint takes the
      // results and produces the structured assessment. The client
      // orchestrates the two calls (see runPatentAssessment below).
      endpoint:       '__patent_two_phase__',
      brieflabel:     'Patent Assessment',
      bodyForFetch:   () => ({}),
      render:         renderPatent,
      formatForBrief: formatPatentForBrief,
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
      ep_id:         'wren_calloway',
      operation:     'append',
      section_label: meta.title ? `${meta.brieflabel}: ${String(meta.title).slice(0, 80)}` : meta.brieflabel,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `${meta.brieflabel} drafted by Wren.`,
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  // ── Renderer ──────────────────────────────────────────────────────────
  function renderScout(data) {
    const segments     = Array.isArray(data.where_it_can_work) ? data.where_it_can_work : [];
    const focus        = data.focus_recommendation || null;
    const otherUses    = Array.isArray(data.other_uses) ? data.other_uses : [];
    const adjacent     = Array.isArray(data.adjacent_moves) ? data.adjacent_moves : [];
    const whiteSpace   = Array.isArray(data.white_space_map) ? data.white_space_map : [];
    const hooks        = Array.isArray(data.search_hooks) ? data.search_hooks : [];
    const dontDo       = String(data.one_thing_not_to_do || '');
    const rationale    = String(data.rationale || '');

    // Where it can work
    const segmentsHtml = segments.map(s => ''
      + '<article class="wt-segment">'
      +   '<div class="wt-segment-head">'
      +     '<h4>' + escapeHtml(s.segment || '') + '</h4>'
      +     '<span class="wt-density wt-density-' + escapeHtml((s.density || '').toLowerCase()) + '">' + escapeHtml(s.density || '') + '</span>'
      +   '</div>'
      +   '<p class="wt-segment-why">' + escapeHtml(s.why_fit || '') + '</p>'
      +   '<p class="wt-segment-signal"><strong>First signal:</strong> ' + escapeHtml(s.first_signal || '') + '</p>'
      + '</article>'
    ).join('');

    // Focus recommendation
    const focusHtml = focus
      ? '<div class="wt-focus">'
        + '<div class="wt-focus-label">Beachhead</div>'
        + '<div class="wt-focus-segment">' + escapeHtml(focus.segment || '') + '</div>'
        + '<p class="wt-focus-reason">' + escapeHtml(focus.reasoning || '') + '</p>'
      + '</div>'
      : '';

    // Other Uses (the SLR-Studio insight)
    const otherUsesHtml = otherUses.map(o => ''
      + '<article class="wt-other-use">'
      +   '<h4>' + escapeHtml(o.domain || '') + '</h4>'
      +   '<p class="wt-other-fit"><span class="wt-mini-label">Mechanic fit:</span> ' + escapeHtml(o.mechanic_fit || '') + '</p>'
      +   '<p class="wt-other-evidence"><span class="wt-mini-label">How to know it\'s real:</span> ' + escapeHtml(o.evidence_or_signal || '') + '</p>'
      + '</article>'
    ).join('');

    // Adjacent moves
    const adjacentHtml = adjacent.map(a => ''
      + '<article class="wt-adjacent">'
      +   '<p class="wt-adjacent-move">' + escapeHtml(a.move || '') + '</p>'
      +   '<div class="wt-adjacent-grid">'
      +     '<div><div class="wt-mini-label">What changes</div><p>' + escapeHtml(a.what_changes || '') + '</p></div>'
      +     '<div><div class="wt-mini-label">What stays</div><p>' + escapeHtml(a.what_stays || '') + '</p></div>'
      +   '</div>'
      + '</article>'
    ).join('');

    // White space map
    const whiteSpaceHtml = whiteSpace.map(g => ''
      + '<article class="wt-gap wt-gap-' + escapeHtml((g.verdict || '').toLowerCase()) + '">'
      +   '<div class="wt-gap-head">'
      +     '<span class="wt-verdict wt-verdict-' + escapeHtml((g.verdict || '').toLowerCase()) + '">' + escapeHtml(g.verdict || '') + '</span>'
      +     '<h4>' + escapeHtml(g.gap || '') + '</h4>'
      +   '</div>'
      +   '<p>' + escapeHtml(g.why_empty || '') + '</p>'
      + '</article>'
    ).join('');

    // Search hooks
    const hooksHtml = hooks.map(h => ''
      + '<article class="wt-hook">'
      +   '<div class="wt-hook-query">' + escapeHtml(h.query || '') + '</div>'
      +   '<div class="wt-hook-meta">'
      +     '<span class="wt-hook-where">' + escapeHtml(h.where || '') + '</span>'
      +     '<span class="wt-hook-for">' + escapeHtml(h.looking_for || '') + '</span>'
      +   '</div>'
      + '</article>'
    ).join('');

    return ''
      + (segmentsHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Where it can work (markets for the core use case)</div>'
            + '<div class="wt-segment-list">' + segmentsHtml + '</div></div>'
          : '')
      + (focusHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Focus recommendation (start here)</div>' + focusHtml + '</div>'
          : '')
      + (otherUsesHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Other Uses (same mechanic, different problem domains)</div>'
            + '<div class="wt-other-use-list">' + otherUsesHtml + '</div></div>'
          : '')
      + (adjacentHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Adjacent moves (small pivots to nearby markets)</div>'
            + '<div class="wt-adjacent-list">' + adjacentHtml + '</div></div>'
          : '')
      + (whiteSpaceHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">White space map</div>'
            + '<div class="wt-gap-list">' + whiteSpaceHtml + '</div></div>'
          : '')
      + (hooksHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Search hooks (run these yourself to verify)</div>'
            + '<div class="wt-hook-list">' + hooksHtml + '</div></div>'
          : '')
      + (dontDo
          ? '<div class="rt-out-block"><div class="rt-out-label">One thing Wren would not do</div>'
            + '<div class="wt-dont">' + escapeHtml(dontDo) + '</div></div>'
          : '')
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  function formatScoutForBrief(data) {
    const lines = [];

    if (Array.isArray(data.where_it_can_work) && data.where_it_can_work.length) {
      lines.push('WHERE IT CAN WORK');
      data.where_it_can_work.forEach(s => {
        lines.push(`  - ${s.segment}  [${s.density}]`);
        lines.push(`      ${s.why_fit}`);
        lines.push(`      First signal: ${s.first_signal}`);
      });
      lines.push('');
    }

    if (data.focus_recommendation) {
      lines.push('FOCUS RECOMMENDATION (start here)');
      lines.push(`  ${data.focus_recommendation.segment}`);
      lines.push(`  ${data.focus_recommendation.reasoning}`);
      lines.push('');
    }

    if (Array.isArray(data.other_uses) && data.other_uses.length) {
      lines.push('OTHER USES (same mechanic, different domain)');
      data.other_uses.forEach(o => {
        lines.push(`  - ${o.domain}`);
        lines.push(`      Mechanic fit: ${o.mechanic_fit}`);
        lines.push(`      How to know it's real: ${o.evidence_or_signal}`);
      });
      lines.push('');
    }

    if (Array.isArray(data.adjacent_moves) && data.adjacent_moves.length) {
      lines.push('ADJACENT MOVES');
      data.adjacent_moves.forEach(a => {
        lines.push(`  - ${a.move}`);
        lines.push(`      Changes: ${a.what_changes}`);
        lines.push(`      Stays:   ${a.what_stays}`);
      });
      lines.push('');
    }

    if (Array.isArray(data.white_space_map) && data.white_space_map.length) {
      lines.push('WHITE SPACE MAP');
      data.white_space_map.forEach(g => {
        lines.push(`  - [${(g.verdict || '').toUpperCase()}] ${g.gap}`);
        lines.push(`      ${g.why_empty}`);
      });
      lines.push('');
    }

    if (Array.isArray(data.search_hooks) && data.search_hooks.length) {
      lines.push('SEARCH HOOKS');
      data.search_hooks.forEach(h => {
        lines.push(`  - "${h.query}"  [${h.where}]`);
        lines.push(`      ${h.looking_for}`);
      });
      lines.push('');
    }

    if (data.one_thing_not_to_do) {
      lines.push('ONE THING NOT TO DO');
      lines.push(`  ${data.one_thing_not_to_do}`);
      lines.push('');
    }

    if (data.rationale) {
      lines.push('NOTE');
      lines.push(`  ${data.rationale}`);
    }

    const title = (data.focus_recommendation && data.focus_recommendation.segment) || '';
    return { plainText: lines.join('\n'), title };
  }

  async function generate(form, toolKey) {
    const cfg = TOOLS[toolKey];
    if (!cfg) return;

    const submitBtn = form.querySelector('[data-wt="generate"]');
    const resultEl  = form.querySelector('[data-wt="result"]');

    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal first. Wren scouts from the brief.</div>';
      return;
    }
    const name = (ss(KEY_NAME) || '').trim();

    submitBtn.disabled = true;
    const origLabel = submitBtn.textContent;
    submitBtn.textContent = toolKey === 'patent' ? 'Searching patents...' : 'Scouting...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">' + (
      toolKey === 'patent'
        ? 'Phase 1 of 2: Wren is extracting your search queries and running them on Google Patents...'
        : 'Wren is scouting the landscape. About 25-30 seconds.'
    ) + '</div>';

    try {
      let data;

      if (toolKey === 'patent') {
        // Two-phase patent assessment. Each phase fits inside Netlify's
        // 26-second function cap. Client orchestrates the sequence and
        // updates the status copy between phases.
        data = await runPatentAssessment(brief, name, resultEl, submitBtn);
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
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
        data = await resp.json();
      }

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
        + (toolKey === 'patent'
            ? ''
            : '<p class="zh-result-saved">Saved to your brief and revision log. The search hooks are the verification step - run each on the database listed, then come back.</p>');
    } catch (err) {
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-wren-tools:' + toolKey + ']', msg);
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">' + (
        isTimeout
          ? 'Wren took too long. Try again, or refresh the page.'
          : 'Could not build the report. Try again.'
      ) + '</div>';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origLabel;
    }
  }

  // Two-phase patent assessment. Phase 1: queries + SerpAPI search.
  // Phase 2: LLM analysis of the prior-art results. Updates the status
  // message between phases so the visitor sees real progress.
  async function runPatentAssessment(brief, name, resultEl, submitBtn) {
    const PHASE_TIMEOUT = 35000;

    // Phase 1: queries + search
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort('timeout'), PHASE_TIMEOUT);
    let phase1;
    try {
      const r = await fetch('/.netlify/functions/tg-wren-patent-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, name }),
        signal: ctrl1.signal,
      });
      clearTimeout(t1);
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error('patent-queries ' + r.status + ' ' + text.slice(0, 200));
      }
      phase1 = await r.json();
    } catch (err) {
      clearTimeout(t1);
      throw err;
    }

    const found = Array.isArray(phase1.prior_art) ? phase1.prior_art.length : 0;
    if (submitBtn) submitBtn.textContent = 'Analyzing...';
    resultEl.innerHTML = '<div class="zh-result-msg">Phase 2 of 2: ' + found + ' patents pulled. Wren is reading the prior art against your brief...</div>';

    // Phase 2: analysis
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort('timeout'), PHASE_TIMEOUT);
    let phase2;
    try {
      const r = await fetch('/.netlify/functions/tg-wren-patent-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief, name,
          queries:           phase1.queries,
          technical_summary: phase1.technical_summary,
          prior_art:         phase1.prior_art,
        }),
        signal: ctrl2.signal,
      });
      clearTimeout(t2);
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error('patent-analyze ' + r.status + ' ' + text.slice(0, 200));
      }
      phase2 = await r.json();
    } catch (err) {
      clearTimeout(t2);
      throw err;
    }

    // Phase 2 returns the canonical shape; phase 1 metadata is already
    // included by tg-wren-patent-analyze (queries_used, technical_summary).
    return phase2;
  }

  // ── Patent assessment renderer + brief-formatter ──────────────────────

  function fitClass(fit) {
    const f = String(fit || '').toLowerCase();
    if (f === 'good fit') return 'wt-fit-good';
    if (f === 'not recommended') return 'wt-fit-not';
    return 'wt-fit-marginal';
  }

  function renderPatent(data) {
    const queries  = Array.isArray(data.queries_used) ? data.queries_used : [];
    const techSum  = String(data.technical_summary || '');
    const priorArt = Array.isArray(data.prior_art) ? data.prior_art : [];
    const pat      = data.patentability && typeof data.patentability === 'object' ? data.patentability : {};
    const cpc      = Array.isArray(data.cpc_codes) ? data.cpc_codes : [];
    const nexts    = Array.isArray(data.next_steps) ? data.next_steps : [];
    const rationale = String(data.rationale || '');

    const techHtml = techSum
      ? '<div class="wt-tech-summary"><div class="wt-section-label">Technical reading</div><p>' + escapeHtml(techSum) + '</p></div>'
      : '';

    const queriesHtml = queries.length
      ? '<div class="wt-queries"><div class="wt-section-label">Queries searched</div><ul>' +
        queries.map(q => '<li><code>' + escapeHtml(q) + '</code></li>').join('') + '</ul></div>'
      : '';

    const priorArtHtml = priorArt.length
      ? '<div class="wt-prior-art"><div class="wt-section-label">Prior-art landscape (' + priorArt.length + ' patents)</div>' +
        priorArt.map(p => ''
          + '<article class="wt-patent">'
          +   '<header class="wt-patent-head">'
          +     '<div class="wt-patent-title">' + escapeHtml(p.title || 'Untitled') + '</div>'
          +     '<span class="wt-patent-overlap wt-overlap-' + escapeHtml(String(p.claim_overlap || 'adjacent').replace(/[^a-z]/g, '')) + '">' + escapeHtml(p.claim_overlap || 'adjacent') + '</span>'
          +   '</header>'
          +   '<div class="wt-patent-meta">'
          +     (p.publication_number ? '<span>' + escapeHtml(p.publication_number) + '</span>' : '')
          +     (p.assignee           ? '<span>' + escapeHtml(p.assignee)           + '</span>' : '')
          +     (p.publication_year   ? '<span>' + escapeHtml(p.publication_year)   + '</span>' : '')
          +   '</div>'
          +   (p.abstract  ? '<p class="wt-patent-abstract">'  + escapeHtml(p.abstract)  + '</p>' : '')
          +   (p.relevance ? '<p class="wt-patent-relevance">' + escapeHtml(p.relevance) + '</p>' : '')
          +   (p.link      ? '<a class="wt-patent-link" href="' + escapeHtml(p.link) + '" target="_blank" rel="noopener">View on Google Patents &rarr;</a>' : '')
          + '</article>'
        ).join('') +
        '</div>'
      : '<div class="wt-prior-art-empty">No relevant prior art surfaced in the search. Either the field is novel or the indexing is thin - treat the empty result as a signal, not a green light.</div>';

    const strongHtml = (Array.isArray(pat.strong_claims) ? pat.strong_claims : [])
      .map(s => '<li>' + escapeHtml(s) + '</li>').join('');
    const weakHtml   = (Array.isArray(pat.weak_claims) ? pat.weak_claims : [])
      .map(s => '<li>' + escapeHtml(s) + '</li>').join('');
    const gapsHtml   = (Array.isArray(pat.gaps) ? pat.gaps : [])
      .map(s => '<li>' + escapeHtml(s) + '</li>').join('');

    const patentabilityHtml = ''
      + '<div class="wt-patentability"><div class="wt-section-label">Patentability assessment</div>'
      + (pat.summary ? '<p class="wt-pat-summary">' + escapeHtml(pat.summary) + '</p>' : '')
      + (strongHtml ? '<div class="wt-pat-block"><div class="wt-pat-block-label">Claims likely to survive</div><ul>' + strongHtml + '</ul></div>' : '')
      + (weakHtml   ? '<div class="wt-pat-block"><div class="wt-pat-block-label">Claims likely DOA against prior art</div><ul>' + weakHtml   + '</ul></div>' : '')
      + (gapsHtml   ? '<div class="wt-pat-block"><div class="wt-pat-block-label">White space worth planting a flag in</div><ul>' + gapsHtml   + '</ul></div>' : '')
      + '</div>';

    const cpcHtml = cpc.length
      ? '<div class="wt-cpc"><div class="wt-section-label">Suggested CPC classifications</div>' +
        cpc.map(c => ''
          + '<div class="wt-cpc-row">'
          +   '<code class="wt-cpc-code">' + escapeHtml(c.code || '') + '</code>'
          +   '<div class="wt-cpc-body">'
          +     '<div class="wt-cpc-label">' + escapeHtml(c.label || '') + '</div>'
          +     '<div class="wt-cpc-why">'   + escapeHtml(c.why   || '') + '</div>'
          +   '</div>'
          + '</div>'
        ).join('') +
        '</div>'
      : '';

    const nextHtml = nexts.length
      ? '<div class="wt-next"><div class="wt-section-label">What to do next</div>' +
        nexts.map(s => ''
          + '<article class="wt-next-card ' + fitClass(s.fit) + '">'
          +   '<header class="wt-next-head">'
          +     '<div class="wt-next-option">' + escapeHtml(s.option || '') + '</div>'
          +     '<span class="wt-next-fit">' + escapeHtml(s.fit || '') + '</span>'
          +   '</header>'
          +   (s.action        ? '<p class="wt-next-action">'        + escapeHtml(s.action)        + '</p>' : '')
          +   (s.cost_estimate ? '<div class="wt-next-cost">' + escapeHtml(s.cost_estimate) + '</div>' : '')
          + '</article>'
        ).join('') +
        '</div>'
      : '';

    return ''
      + techHtml
      + queriesHtml
      + priorArtHtml
      + patentabilityHtml
      + cpcHtml
      + nextHtml
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '')
      + '<p class="zh-result-saved">Saved to your brief and revision log. Not legal advice - bring this prep work to a real patent attorney before filing.</p>';
  }

  function formatPatentForBrief(data) {
    const lines = [];
    const queries  = Array.isArray(data.queries_used) ? data.queries_used : [];
    const priorArt = Array.isArray(data.prior_art) ? data.prior_art : [];
    const pat      = data.patentability && typeof data.patentability === 'object' ? data.patentability : {};
    const cpc      = Array.isArray(data.cpc_codes) ? data.cpc_codes : [];
    const nexts    = Array.isArray(data.next_steps) ? data.next_steps : [];

    if (data.technical_summary) {
      lines.push('TECHNICAL READING:');
      lines.push(data.technical_summary);
      lines.push('');
    }

    if (queries.length) {
      lines.push('QUERIES SEARCHED:');
      queries.forEach((q, i) => lines.push('  ' + (i + 1) + '. ' + q));
      lines.push('');
    }

    lines.push('PRIOR-ART LANDSCAPE (' + priorArt.length + ' patents):');
    if (priorArt.length) {
      priorArt.forEach((p, i) => {
        lines.push('');
        lines.push('  ' + (i + 1) + '. ' + (p.title || 'Untitled') + ' [' + (p.claim_overlap || 'adjacent') + ']');
        const meta = [p.publication_number, p.assignee, p.publication_year].filter(Boolean).join(' | ');
        if (meta) lines.push('     ' + meta);
        if (p.abstract)  lines.push('     Abstract: ' + p.abstract);
        if (p.relevance) lines.push('     Relevance: ' + p.relevance);
        if (p.link)      lines.push('     ' + p.link);
      });
    } else {
      lines.push('  (No relevant prior art surfaced. Treat as a signal, not a green light.)');
    }
    lines.push('');

    lines.push('PATENTABILITY:');
    if (pat.summary) lines.push('  ' + pat.summary);
    if (Array.isArray(pat.strong_claims) && pat.strong_claims.length) {
      lines.push('  Strong claims:');
      pat.strong_claims.forEach(s => lines.push('    - ' + s));
    }
    if (Array.isArray(pat.weak_claims) && pat.weak_claims.length) {
      lines.push('  Weak claims:');
      pat.weak_claims.forEach(s => lines.push('    - ' + s));
    }
    if (Array.isArray(pat.gaps) && pat.gaps.length) {
      lines.push('  White space:');
      pat.gaps.forEach(s => lines.push('    - ' + s));
    }
    lines.push('');

    if (cpc.length) {
      lines.push('SUGGESTED CPC CODES:');
      cpc.forEach(c => lines.push('  ' + (c.code || '') + ' - ' + (c.label || '') + ' (' + (c.why || '') + ')'));
      lines.push('');
    }

    if (nexts.length) {
      lines.push('NEXT STEPS:');
      nexts.forEach(s => {
        lines.push('  ' + (s.option || '') + ' [' + (s.fit || '') + '] - ' + (s.cost_estimate || ''));
        if (s.action) lines.push('    Action: ' + s.action);
      });
      lines.push('');
    }

    if (data.rationale) {
      lines.push('RATIONALE: ' + data.rationale);
    }

    lines.push('');
    lines.push('NOT LEGAL ADVICE. Bring this prep work to a registered patent attorney before filing.');

    // Title for the brief-append header. Prefer the strongest claim
    // concept; fall back to a generic label.
    let title = 'Patent Assessment';
    if (pat && Array.isArray(pat.strong_claims) && pat.strong_claims.length) {
      title = String(pat.strong_claims[0]).slice(0, 80);
    } else if (priorArt.length) {
      title = 'vs. ' + String(priorArt[0].title || '').slice(0, 60);
    }
    return { plainText: lines.join('\n'), title };
  }

  function init() {
    document.querySelectorAll('[data-wt-tool]').forEach(form => {
      const toolKey = form.getAttribute('data-wt-tool');
      if (!TOOLS[toolKey]) return;
      const submitBtn = form.querySelector('[data-wt="generate"]');
      if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(form, toolKey); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
