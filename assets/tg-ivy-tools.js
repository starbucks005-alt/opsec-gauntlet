/* ─────────────────────────────────────────────────────────────────────────────
   tg-ivy-tools.js — Idea Generator + Research Context for Ivy's office.

   Two tools, two cards, one client:
     - generate (tool A): visitor enters world / frustration / capability,
       Ivy returns 3 idea candidates. The PICKED candidate becomes the
       visitor's brief in sessionStorage and walks through The Gauntlet.
     - context (tool B): reads the brief, returns frameworks / adjacent
       thinkers / prior literature / the research gap.

   Generator behavior is slightly different from the other hubs - the
   candidates are PROPOSED, not auto-appended. The visitor picks one, and
   the picked candidate THEN replaces (or seeds) the brief. This is the
   only hub where the deliverable is a CHOICE, not a fait accompli.

   The "context" tool follows the standard pattern - reads the brief,
   appends results to the brief + revision log.

   SessionStorage: tg_visitor_brief, tg_visitor_name, tg_ep_revisions.
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 45000;

  const EP_OFFICES = {
    reid_callum:   '/Helpers/reid-marketing.html',
    zara_cole:     '/Helpers/zara-influencer.html',
    jules:         '/Helpers/jules-rewrite.html',
    grant_ellis:   '/Helpers/grant-coach.html',
    arjun_mehta:   '/Helpers/arjun-delivery.html',
    matthew_vance: '/Helpers/matthew-behaviorist.html',
    wren_calloway: '/Helpers/wren-scout.html',
    carol_haynes:  '/Helpers/carol-screener.html',
  };
  const EP_SHORT = {
    reid_callum:   'Reid',
    zara_cole:     'Zara',
    jules:         'Jules',
    grant_ellis:   'Grant',
    arjun_mehta:   'Arjun',
    matthew_vance: 'Matthew',
    wren_calloway: 'Wren',
    carol_haynes:  'Carol',
  };

  const TOOLS = {
    generate: {
      endpoint:     '/.netlify/functions/tg-ivy-generate',
      brieflabel:   'Idea Candidates',
      bodyForFetch: (form) => {
        const world       = (form.querySelector('[data-iv="world"]')       || {}).value || '';
        const frustration = (form.querySelector('[data-iv="frustration"]') || {}).value || '';
        const capability  = (form.querySelector('[data-iv="capability"]')  || {}).value || '';
        return { world: world.trim(), frustration: frustration.trim(), capability: capability.trim() };
      },
      requiresBrief: false,                  // generator does NOT need a brief; that is its job
      render:        renderGenerate,
      // No formatForBrief - the generator does NOT auto-append. The
      // visitor picks one candidate (via the per-candidate "Make this
      // my brief" button rendered inside renderGenerate).
    },
    context: {
      endpoint:      '/.netlify/functions/tg-ivy-context',
      brieflabel:    'Research Context',
      bodyForFetch:  () => ({}),
      requiresBrief: true,
      render:        renderContext,
      formatForBrief: formatContextForBrief,
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
      briefEl.textContent = 'No brief yet. Use Idea Generator above, or drop something in from the welcome modal.';
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
      ep_id:         'ms_ivy',
      operation:     'append',
      section_label: meta.title ? `${meta.brieflabel}: ${String(meta.title).slice(0, 80)}` : meta.brieflabel,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `${meta.brieflabel} from Ivy.`,
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  // SEED-the-brief flow used when the visitor picks an Idea Generator
  // candidate. Replaces (or sets) the brief with the candidate text and
  // writes a single revision-log entry marking that this brief CAME FROM
  // Ivy's idea generation. Different from appendToBrief in that this is
  // SEEDING, not adding to existing brief content.
  function seedBriefFromCandidate(candidate) {
    const seed = [
      candidate.name ? `WORKING NAME: ${candidate.name}` : '',
      '',
      candidate.what_it_is || '',
      '',
      candidate.the_gap          ? `THE GAP THIS FILLS\n${candidate.the_gap}`                            : '',
      candidate.adjacent_research ? `\nADJACENT RESEARCH\n${candidate.adjacent_research}`               : '',
      candidate.first_validation  ? `\nFIRST VALIDATION (next 30 days)\n${candidate.first_validation}`  : '',
    ].filter(Boolean).join('\n').trim();

    ssSet(KEY_BRIEF, seed);

    const revisions = ssJson(KEY_REVISIONS, []);
    revisions.push({
      ep_id:         'ms_ivy',
      operation:     'append',                          // seeded, but treated as an append for export consistency
      section_label: `Idea Candidate (seeded): ${String(candidate.name || '').slice(0, 80)}`,
      before:        '',
      after:         seed,
      rationale:     'Visitor picked this candidate from Ivy\'s Idea Generator. This is the seed of the brief.',
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  // ── Generator render ──────────────────────────────────────────────────
  function renderGenerate(data) {
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const rationale  = String(data.rationale || '');

    const cardsHtml = candidates.map((c, idx) => {
      const epRef = c.which_ep_next && EP_OFFICES[c.which_ep_next.ep];
      const epChip = epRef
        ? '<a class="iv-cand-ep" href="' + escapeHtml(epRef) + '">'
          + 'next: step in with ' + escapeHtml(EP_SHORT[c.which_ep_next.ep] || c.which_ep_next.ep) + ' &rarr;'
          + '</a>'
        : '';
      const epReason = c.which_ep_next && c.which_ep_next.reason
        ? '<p class="iv-cand-ep-reason"><span class="wt-mini-label">Why this EP first:</span> ' + escapeHtml(c.which_ep_next.reason) + '</p>'
        : '';

      return ''
        + '<article class="iv-cand" data-iv-cand-idx="' + idx + '">'
        +   '<div class="iv-cand-head">'
        +     '<div class="iv-cand-num">' + (idx + 1) + '</div>'
        +     '<h4 class="iv-cand-name">' + escapeHtml(c.name || '') + '</h4>'
        +   '</div>'
        +   '<p class="iv-cand-body">' + escapeHtml(c.what_it_is || '') + '</p>'
        +   '<div class="iv-cand-row"><span class="wt-mini-label">The gap:</span> <span>' + escapeHtml(c.the_gap || '') + '</span></div>'
        +   '<div class="iv-cand-row"><span class="wt-mini-label">Adjacent research:</span> <span>' + escapeHtml(c.adjacent_research || '') + '</span></div>'
        +   '<div class="iv-cand-row"><span class="wt-mini-label">First validation:</span> <span>' + escapeHtml(c.first_validation || '') + '</span></div>'
        +   epReason
        +   '<div class="iv-cand-actions">'
        +     '<button type="button" class="iv-cand-pick" data-iv-pick="' + idx + '">Make this my brief &rarr;</button>'
        +     epChip
        +   '</div>'
        + '</article>';
    }).join('');

    return ''
      + '<div class="iv-cand-list">' + cardsHtml + '</div>'
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  // Wire the per-candidate "Make this my brief" buttons. Called every
  // time the generator renders new candidates.
  function wireGeneratorActions(resultEl, candidates) {
    resultEl.querySelectorAll('[data-iv-pick]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-iv-pick'), 10);
        const cand = candidates[idx];
        if (!cand) return;
        const ok = window.confirm(
          'Make "' + (cand.name || 'this candidate') + '" your working brief?\n\n'
          + 'This replaces whatever is in your brief panel right now. '
          + 'The candidate text becomes your starting point and you can sharpen it with the other EPs.'
        );
        if (!ok) return;
        seedBriefFromCandidate(cand);
        // Visual feedback: mark this candidate as picked, dim the rest.
        resultEl.querySelectorAll('.iv-cand').forEach(c => c.classList.remove('is-picked', 'is-dim'));
        const picked = resultEl.querySelector('[data-iv-cand-idx="' + idx + '"]');
        if (picked) picked.classList.add('is-picked');
        resultEl.querySelectorAll('.iv-cand').forEach(c => {
          if (c !== picked) c.classList.add('is-dim');
        });
        btn.disabled = true;
        btn.textContent = 'Set as your brief';
      });
    });
  }

  // ── Context render ────────────────────────────────────────────────────
  function renderContext(data) {
    const frameworks = Array.isArray(data.frameworks)        ? data.frameworks        : [];
    const thinkers   = Array.isArray(data.adjacent_thinkers) ? data.adjacent_thinkers : [];
    const lit        = Array.isArray(data.prior_literature)  ? data.prior_literature  : [];
    const gap        = String(data.the_research_gap || '');
    const rationale  = String(data.rationale || '');

    const fwHtml = frameworks.map(f => ''
      + '<article class="iv-fw">'
      +   '<h4>' + escapeHtml(f.framework_name || '') + '</h4>'
      +   (f.author_or_origin ? '<div class="iv-fw-author">' + escapeHtml(f.author_or_origin) + '</div>' : '')
      +   '<p>' + escapeHtml(f.why_relevant || '') + '</p>'
      + '</article>'
    ).join('');

    const thHtml = thinkers.map(t => ''
      + '<article class="iv-thinker">'
      +   '<div class="iv-thinker-head">'
      +     '<h4>' + escapeHtml(t.name || '') + '</h4>'
      +     '<span class="iv-thinker-thread">' + escapeHtml(t.their_thread || '') + '</span>'
      +   '</div>'
      +   '<p>' + escapeHtml(t.why_relevant || '') + '</p>'
      + '</article>'
    ).join('');

    const litHtml = lit.map(p => ''
      + '<article class="iv-lit">'
      +   '<h4>' + escapeHtml(p.topic || '') + '</h4>'
      +   '<p class="iv-lit-est"><span class="wt-mini-label">Established:</span> ' + escapeHtml(p.what_it_established || '') + '</p>'
      +   '<p class="iv-lit-ground"><span class="wt-mini-label">Grounds your idea:</span> ' + escapeHtml(p.how_it_grounds_this_idea || '') + '</p>'
      + '</article>'
    ).join('');

    return ''
      + (fwHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Frameworks worth knowing</div>'
            + '<div class="iv-fw-list">' + fwHtml + '</div></div>'
          : '')
      + (thHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Adjacent thinkers</div>'
            + '<div class="iv-thinker-list">' + thHtml + '</div></div>'
          : '')
      + (litHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Prior literature</div>'
            + '<div class="iv-lit-list">' + litHtml + '</div></div>'
          : '')
      + (gap
          ? '<div class="rt-out-block"><div class="rt-out-label">The research gap</div>'
            + '<div class="iv-gap">' + escapeHtml(gap) + '</div></div>'
          : '')
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  function formatContextForBrief(data) {
    const lines = [];
    if (Array.isArray(data.frameworks) && data.frameworks.length) {
      lines.push('FRAMEWORKS');
      data.frameworks.forEach(f => {
        lines.push(`  - ${f.framework_name} (${f.author_or_origin || 'author n/a'})`);
        lines.push(`      ${f.why_relevant || ''}`);
      });
      lines.push('');
    }
    if (Array.isArray(data.adjacent_thinkers) && data.adjacent_thinkers.length) {
      lines.push('ADJACENT THINKERS');
      data.adjacent_thinkers.forEach(t => {
        lines.push(`  - ${t.name} - ${t.their_thread || ''}`);
        lines.push(`      ${t.why_relevant || ''}`);
      });
      lines.push('');
    }
    if (Array.isArray(data.prior_literature) && data.prior_literature.length) {
      lines.push('PRIOR LITERATURE');
      data.prior_literature.forEach(p => {
        lines.push(`  - ${p.topic}`);
        lines.push(`      Established: ${p.what_it_established}`);
        lines.push(`      Grounds your idea: ${p.how_it_grounds_this_idea}`);
      });
      lines.push('');
    }
    if (data.the_research_gap) {
      lines.push('THE RESEARCH GAP');
      lines.push(`  ${data.the_research_gap}`);
      lines.push('');
    }
    if (data.rationale) {
      lines.push('NOTE');
      lines.push(`  ${data.rationale}`);
    }
    return { plainText: lines.join('\n'), title: '' };
  }

  // ── Shared generate ───────────────────────────────────────────────────
  async function generate(form, toolKey) {
    const cfg = TOOLS[toolKey];
    if (!cfg) return;

    const submitBtn = form.querySelector('[data-iv="generate"]');
    const resultEl  = form.querySelector('[data-iv="result"]');

    const fetchBody = Object.assign({}, cfg.bodyForFetch(form));
    if (cfg.requiresBrief) {
      const brief = (ss(KEY_BRIEF) || '').trim();
      if (brief.length < 30) {
        resultEl.className = 'zh-result is-error';
        resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal first - or use Ivy\'s Idea Generator above to create one.</div>';
        return;
      }
      fetchBody.brief = brief;
    }
    const name = (ss(KEY_NAME) || '').trim();
    if (name) fetchBody.name = name;

    submitBtn.disabled = true;
    const origLabel = submitBtn.textContent;
    submitBtn.textContent = toolKey === 'generate' ? 'Mapping the space...' : 'Reading the field...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">' + (
      toolKey === 'generate'
        ? 'Ivy is mapping the space around your intake. About 20-30 seconds.'
        : 'Ivy is finding the research context. About 20-30 seconds.'
    ) + '</div>';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(cfg.endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(fetchBody),
        signal:  controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(toolKey + ' ' + resp.status + ' ' + text.slice(0, 200));
      }
      const data = await resp.json();

      // Context tool auto-appends to brief; generator does NOT (visitor picks).
      if (toolKey === 'context' && cfg.formatForBrief) {
        const formatted = cfg.formatForBrief(data);
        appendToBrief(formatted.plainText, {
          brieflabel: cfg.brieflabel,
          title:      formatted.title,
          rationale:  data.rationale,
        });
      }

      resultEl.className = 'zh-result is-ready';
      resultEl.innerHTML = ''
        + '<div class="zh-result-meta">'
        +   '<span class="zh-result-platform">' + escapeHtml(cfg.brieflabel) + '</span>'
        + '</div>'
        + cfg.render(data)
        + (toolKey === 'context'
            ? '<p class="zh-result-saved">Saved to your brief and revision log.</p>'
            : '<p class="zh-result-saved">Pick a candidate below to make it your working brief, then walk it through The Gauntlet.</p>');

      // Wire per-candidate "Make this my brief" buttons after the render
      // is inserted into the DOM.
      if (toolKey === 'generate' && Array.isArray(data.candidates)) {
        wireGeneratorActions(resultEl, data.candidates);
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-ivy-tools:' + toolKey + ']', msg);
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">' + (
        isTimeout
          ? 'Ivy took too long. Try again, or refresh the page.'
          : 'Could not complete the search. Try again.'
      ) + '</div>';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origLabel;
    }
  }

  function init() {
    document.querySelectorAll('[data-iv-tool]').forEach(form => {
      const toolKey = form.getAttribute('data-iv-tool');
      if (!TOOLS[toolKey]) return;
      const submitBtn = form.querySelector('[data-iv="generate"]');
      if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(form, toolKey); });
    });
    rerenderBriefPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
