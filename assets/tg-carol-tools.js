/* ─────────────────────────────────────────────────────────────────────────────
   tg-carol-tools.js — Screening Report generator for Carol's office.

   Mirrors tg-matthew-tools / tg-arjun-tools / tg-reid-tools pattern.
   Renders patterns, legs assessment with internal signal score and
   verdict, improvement actions (some routed to other EP offices as
   clickable links), and the one thing that kills the idea.

   SessionStorage:
     tg_visitor_brief    - mutated when the report returns
     tg_visitor_name     - greeting
     tg_ep_revisions     - revision log (report appended)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 45000;

  // EP id -> office page URL for improvement-action referrals (a clickable
  // link if Carol routes one of her actions to another EP).
  const EP_OFFICES = {
    reid_callum:   '/Helpers/reid-marketing.html',
    zara_cole:     '/Helpers/zara-influencer.html',
    jules:         '/Helpers/jules-rewrite.html',
    grant_ellis:   '/Helpers/grant-coach.html',
    arjun_mehta:   '/Helpers/arjun-delivery.html',
    matthew_vance: '/Helpers/matthew-behaviorist.html',
    wren_calloway: '/Helpers/wren-scout.html',
    ms_ivy:        '/Helpers/ivy-librarian.html',
  };
  // Short labels for the inline referral chip.
  const EP_SHORT = {
    reid_callum:   'Reid',
    zara_cole:     'Zara',
    jules:         'Jules',
    grant_ellis:   'Grant',
    arjun_mehta:   'Arjun',
    matthew_vance: 'Matthew',
    wren_calloway: 'Wren',
    ms_ivy:        'Ms. Ivy',
  };

  const TOOLS = {
    screen: {
      endpoint:       '/.netlify/functions/tg-carol-screen',
      brieflabel:     'Screening Report',
      bodyForFetch:   () => ({}),
      render:         renderScreen,
      formatForBrief: formatScreenForBrief,
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
      ep_id:         'carol_haynes',
      operation:     'append',
      section_label: meta.title ? `${meta.brieflabel}: ${String(meta.title).slice(0, 80)}` : meta.brieflabel,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `${meta.brieflabel} drafted by Carol.`,
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  // Verdict label + class mapping for the legs-assessment chip.
  const VERDICT_LABEL = {
    strong:    'Strong',
    has_legs:  'Has legs',
    marginal:  'Marginal',
    uphill:    'Uphill',
  };

  // ── Renderer ──────────────────────────────────────────────────────────
  function renderScreen(data) {
    const patterns   = Array.isArray(data.patterns) ? data.patterns : [];
    const legs       = data.legs_assessment || {};
    const actions    = Array.isArray(data.improvement_actions) ? data.improvement_actions : [];
    const kill       = String(data.one_thing_that_kills_it || '');
    const rationale  = String(data.rationale || '');

    // Patterns
    const patternsHtml = patterns.map(p => ''
      + '<article class="ct-pattern">'
      +   '<h4 class="ct-pattern-name">' + escapeHtml(p.pattern_name || '') + '</h4>'
      +   '<div class="ct-pattern-grid">'
      +     '<div><div class="ct-pattern-label">What worked</div><p>' + escapeHtml(p.what_worked || '') + '</p></div>'
      +     '<div><div class="ct-pattern-label">What failed</div><p>' + escapeHtml(p.what_failed || '') + '</p></div>'
      +   '</div>'
      +   '<p class="ct-pattern-position"><strong>Your position:</strong> ' + escapeHtml(p.your_position || '') + '</p>'
      + '</article>'
    ).join('');

    // Legs assessment
    const verdict = legs.verdict || 'marginal';
    const verdictLabel = VERDICT_LABEL[verdict] || verdict;
    const score = parseInt(legs.signal_score, 10) || 5;
    const forHtml = (Array.isArray(legs.reasons_for) ? legs.reasons_for : []).map(r => '<li>' + escapeHtml(r) + '</li>').join('');
    const againstHtml = (Array.isArray(legs.reasons_against) ? legs.reasons_against : []).map(r => '<li>' + escapeHtml(r) + '</li>').join('');
    const legsHtml = ''
      + '<div class="ct-legs">'
      +   '<div class="ct-legs-head">'
      +     '<span class="ct-verdict ct-verdict-' + escapeHtml(verdict) + '">' + escapeHtml(verdictLabel) + '</span>'
      +     '<span class="ct-score">Signal: <strong>' + score + '</strong>/10</span>'
      +     '<span class="ct-score-note">(Carol\'s internal read - not the Chamber score)</span>'
      +   '</div>'
      +   '<div class="ct-legs-grid">'
      +     '<div><div class="ct-pattern-label">Reasons for</div><ul class="rt-check-list">' + forHtml + '</ul></div>'
      +     '<div><div class="ct-pattern-label">Reasons against</div><ul class="rt-check-list ct-against">' + againstHtml + '</ul></div>'
      +   '</div>'
      + '</div>';

    // Improvement actions, some with EP referral chip linking to that office
    const actionsHtml = actions.map(a => {
      const refId = a.ep_referral;
      const chip = refId && EP_OFFICES[refId]
        ? '<a class="ct-action-ep" href="' + escapeHtml(EP_OFFICES[refId]) + '">step in with ' + escapeHtml(EP_SHORT[refId] || refId) + ' &rarr;</a>'
        : '';
      return ''
        + '<li class="ct-action">'
        +   '<span class="ct-action-text">' + escapeHtml(a.action) + '</span>'
        +   chip
        + '</li>';
    }).join('');

    return ''
      + '<div class="rt-out-block"><div class="rt-out-label">Comparable venture patterns</div>'
      +   '<div class="ct-pattern-list">' + patternsHtml + '</div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Legs assessment</div>' + legsHtml + '</div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Improvement actions</div>'
      +   '<ol class="ct-action-list">' + actionsHtml + '</ol></div>'
      + (kill
          ? '<div class="rt-out-block"><div class="rt-out-label">The one thing that kills it</div>'
            + '<div class="ct-kill">' + escapeHtml(kill) + '</div></div>'
          : '')
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  function formatScreenForBrief(data) {
    const lines = [];
    lines.push('COMPARABLE VENTURE PATTERNS');
    (data.patterns || []).forEach(p => {
      lines.push(`  - ${p.pattern_name}`);
      lines.push(`      what worked: ${p.what_worked || ''}`);
      lines.push(`      what failed: ${p.what_failed || ''}`);
      lines.push(`      your position: ${p.your_position || ''}`);
    });
    lines.push('');
    const legs = data.legs_assessment || {};
    lines.push(`LEGS ASSESSMENT: ${VERDICT_LABEL[legs.verdict] || legs.verdict || ''}  (Carol's signal: ${legs.signal_score || ''}/10)`);
    if (Array.isArray(legs.reasons_for) && legs.reasons_for.length) {
      lines.push('  Reasons for:');
      legs.reasons_for.forEach(r => lines.push(`    + ${r}`));
    }
    if (Array.isArray(legs.reasons_against) && legs.reasons_against.length) {
      lines.push('  Reasons against:');
      legs.reasons_against.forEach(r => lines.push(`    - ${r}`));
    }
    lines.push('');
    lines.push('IMPROVEMENT ACTIONS');
    (data.improvement_actions || []).forEach((a, i) => {
      const refLabel = a.ep_referral && EP_SHORT[a.ep_referral] ? `  [step in with ${EP_SHORT[a.ep_referral]}]` : '';
      lines.push(`  ${i + 1}. ${a.action}${refLabel}`);
    });
    if (data.one_thing_that_kills_it) {
      lines.push('');
      lines.push('THE ONE THING THAT KILLS IT');
      lines.push(`  ${data.one_thing_that_kills_it}`);
    }
    if (data.rationale) {
      lines.push('');
      lines.push('NOTE');
      lines.push(`  ${data.rationale}`);
    }
    const title = (data.patterns && data.patterns[0] && data.patterns[0].pattern_name)
      ? data.patterns[0].pattern_name
      : '';
    return { plainText: lines.join('\n'), title };
  }

  async function generate(form, toolKey) {
    const cfg = TOOLS[toolKey];
    if (!cfg) return;

    const submitBtn = form.querySelector('[data-ct="generate"]');
    const resultEl  = form.querySelector('[data-ct="result"]');

    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal first. Carol screens against patterns, but she needs the brief to start.</div>';
      return;
    }
    const name = (ss(KEY_NAME) || '').trim();

    submitBtn.disabled = true;
    const origLabel = submitBtn.textContent;
    submitBtn.textContent = 'Screening...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">Carol is reading. About 20-30 seconds.</div>';

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
        + '<p class="zh-result-saved">Saved to your brief and revision log. Improvement actions with a "step in with" link route to the other EP\'s office.</p>';
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-carol-tools:' + toolKey + ']', msg);
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">' + (
        isTimeout
          ? 'Carol took too long. Try again, or refresh the page.'
          : 'Could not build the report. Try again.'
      ) + '</div>';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origLabel;
    }
  }

  function init() {
    document.querySelectorAll('[data-ct-tool]').forEach(form => {
      const toolKey = form.getAttribute('data-ct-tool');
      if (!TOOLS[toolKey]) return;
      const submitBtn = form.querySelector('[data-ct="generate"]');
      if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(form, toolKey); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
