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
    submitBtn.textContent = 'Scouting...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">Wren is scouting the landscape. About 25-30 seconds.</div>';

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
        + '<p class="zh-result-saved">Saved to your brief and revision log. The search hooks are the verification step - run each on the database listed, then come back.</p>';
    } catch (err) {
      clearTimeout(timer);
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
