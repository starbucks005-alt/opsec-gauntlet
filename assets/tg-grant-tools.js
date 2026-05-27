/* ─────────────────────────────────────────────────────────────────────────────
   tg-grant-tools.js — Coach (chamber panel prep) + Pitch (elevator speech)
   generators for Grant's office.

   Two tools share one client because their plumbing is identical to Reid's
   tools.js pattern: form -> fetch -> render -> append-to-brief ->
   revision-log.

   Each tool has its own card in the office HTML (data-gt-tool="coach"|"pitch"),
   its own endpoint, and its own renderer + brief-formatter.

   The interactive Grant chat and the Drill panel stay in tg-ep-chat /
   tg-grant-drill.js. This file adds the two generative tools alongside.

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
  const FETCH_TIMEOUT_MS = 45000;

  // Per-tool config: endpoint, brief label, body builder, renderer,
  // and the plain-text formatter that becomes the brief append.
  const TOOLS = {
    coach: {
      endpoint:       '/.netlify/functions/tg-grant-coach',
      brieflabel:     'Chamber Prep',
      bodyForFetch:   () => ({}), // no extra inputs - brief is enough
      render:         renderCoach,
      formatForBrief: formatCoachForBrief,
      title:          (data) => 'Recommended panel + likely questions',
      loadingMsg:     'Grant is reading your brief and picking your panel. About 15-25 seconds.',
    },
    pitch: {
      endpoint:       '/.netlify/functions/tg-grant-pitch',
      brieflabel:     'Elevator Speech',
      bodyForFetch:   (form) => {
        const ctxPills = form.querySelector('[data-gt="context"]');
        const active = ctxPills && ctxPills.querySelector('.zh-pill.is-active');
        return { context: active ? active.dataset.value : 'general' };
      },
      render:         renderPitch,
      formatForBrief: formatPitchForBrief,
      title:          (data) => `Elevator Speech (${data.context_label || data.context})`,
      loadingMsg:     'Grant is drafting your 30-second speech. About 10-20 seconds.',
    },
  };

  // Context labels for the pitch tool (mirrors VALID_CONTEXTS in the
  // tg-grant-pitch function).
  const CONTEXT_LABELS = {
    investor: 'Investor / VC',
    press:    'Press / Journalist',
    customer: 'Customer / End User',
    partner:  'Partner / Channel',
    academic: 'Academic / Conference',
    general:  'General Professional',
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
    return String(s == null ? '' : s)
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
      ep_id:         'grant_ellis',
      operation:     'append',
      section_label: meta.title ? `${meta.brieflabel}: ${String(meta.title).slice(0, 80)}` : meta.brieflabel,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `${meta.brieflabel} drafted by Grant.`,
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  // ── Renderers (one per tool) ──────────────────────────────────────────

  function renderCoach(data) {
    const panel = Array.isArray(data.recommended_panel) ? data.recommended_panel : [];
    const likely = (data.likely_questions && typeof data.likely_questions === 'object') ? data.likely_questions : {};
    const walkIn = String(data.walk_in_line || '');
    const rationale = String(data.rationale || '');

    const panelHtml = panel.map(p => {
      const qs = Array.isArray(likely[p.judge_id]) ? likely[p.judge_id] : [];
      const qsHtml = qs.map(q => ''
        + '<li class="gt-q">'
        +   '<div class="gt-q-line">' + escapeHtml(q.question || '') + '</div>'
        +   (q.what_they_are_really_asking
              ? '<div class="gt-q-meta">' + escapeHtml(q.what_they_are_really_asking) + '</div>'
              : '')
        + '</li>').join('');
      return ''
        + '<article class="gt-judge">'
        +   '<header class="gt-judge-head">'
        +     '<div class="gt-judge-name">' + escapeHtml(p.judge_name || p.judge_id) + '</div>'
        +     '<div class="gt-judge-beat">' + escapeHtml(p.beat || '') + '</div>'
        +   '</header>'
        +   '<p class="gt-judge-why">' + escapeHtml(p.why_for_this_brief || '') + '</p>'
        +   '<ul class="gt-q-list">' + qsHtml + '</ul>'
        + '</article>';
    }).join('');

    return ''
      + '<div class="gt-walk-in">'
      +   '<div class="gt-walk-in-label">Walk-in line</div>'
      +   '<div class="gt-walk-in-text">' + escapeHtml(walkIn) + '</div>'
      + '</div>'
      + '<div class="gt-judges">' + panelHtml + '</div>'
      + (rationale ? '<p class="gt-rationale">' + escapeHtml(rationale) + '</p>' : '')
      + '<p class="gt-saved">Saved to your brief and revision log. Walk to the chat or the Drill panel below to work through the answers, one judge at a time.</p>';
  }

  function formatCoachForBrief(data) {
    const panel = Array.isArray(data.recommended_panel) ? data.recommended_panel : [];
    const likely = (data.likely_questions && typeof data.likely_questions === 'object') ? data.likely_questions : {};
    const lines = [];
    lines.push('Walk-in line: ' + (data.walk_in_line || ''));
    lines.push('');
    lines.push('RECOMMENDED PANEL (3 of 9 judges):');
    panel.forEach(p => {
      lines.push('');
      lines.push('  ' + (p.judge_name || p.judge_id) + ' - ' + (p.beat || ''));
      lines.push('  Why for this brief: ' + (p.why_for_this_brief || ''));
      const qs = Array.isArray(likely[p.judge_id]) ? likely[p.judge_id] : [];
      qs.forEach((q, i) => {
        lines.push('    Q' + (i + 1) + ': ' + (q.question || ''));
        if (q.what_they_are_really_asking) {
          lines.push('         (really asking: ' + q.what_they_are_really_asking + ')');
        }
      });
    });
    if (data.rationale) {
      lines.push('');
      lines.push('Rationale: ' + data.rationale);
    }
    return lines.join('\n');
  }

  function renderPitch(data) {
    const speech = String(data.speech || '');
    const seconds = parseInt(data.approx_seconds, 10) || 0;
    const words   = parseInt(data.word_count, 10) || 0;
    const hook    = data.hook && typeof data.hook === 'object' ? data.hook : {};
    const rules   = Array.isArray(data.rules_applied) ? data.rules_applied : [];
    const delivery_notes = String(data.delivery_notes || '');
    const close_question = String(data.close_question || '');
    const rationale = String(data.rationale || '');
    const ctxLabel = CONTEXT_LABELS[data.context] || data.context || 'General';

    const rulesHtml = rules.map(r => {
      const label = ({
        never_start_with_name:   '1. Never start with your name',
        lead_with_hook:          '2. Lead with a hook',
        tailor_to_context:       '3. Tailor to this room',
        name_and_question_last:  '4. Name and a question come last',
      })[r.rule] || r.rule;
      return ''
        + '<li class="gt-rule">'
        +   '<div class="gt-rule-label">' + escapeHtml(label) + '</div>'
        +   '<div class="gt-rule-applied">' + escapeHtml(r.applied_as || '') + '</div>'
        + '</li>';
    }).join('');

    return ''
      + '<div class="zh-result-meta">'
      +   '<span class="zh-result-platform">' + escapeHtml(ctxLabel) + '</span>'
      +   '<span class="gt-meta-pill">~' + seconds + ' sec</span>'
      +   '<span class="gt-meta-pill">' + words + ' words</span>'
      +   '<button type="button" class="zh-result-copy" data-gt="copy-speech">Copy speech</button>'
      + '</div>'
      + '<pre class="zh-result-post" data-gt="speech-text">' + escapeHtml(speech) + '</pre>'
      + '<div class="gt-hook">'
      +   '<div class="gt-hook-label">The hook · ' + escapeHtml(hook.type || 'scene') + '</div>'
      +   '<div class="gt-hook-line">' + escapeHtml(hook.line || '') + '</div>'
      +   (hook.why_it_works ? '<p class="gt-hook-why">' + escapeHtml(hook.why_it_works) + '</p>' : '')
      + '</div>'
      + '<div class="gt-rules">'
      +   '<div class="gt-rules-label">Four rules, applied</div>'
      +   '<ul class="gt-rules-list">' + rulesHtml + '</ul>'
      + '</div>'
      + (close_question
          ? '<div class="gt-close-q"><span class="gt-close-q-label">Close on:</span> ' + escapeHtml(close_question) + '</div>'
          : '')
      + (delivery_notes
          ? '<p class="gt-delivery">' + escapeHtml(delivery_notes) + '</p>'
          : '')
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '')
      + '<p class="zh-result-saved">Saved to your brief and revision log. Deliver from memory. Eye contact, not reading.</p>';
  }

  function formatPitchForBrief(data) {
    const ctxLabel = CONTEXT_LABELS[data.context] || data.context || 'General';
    const lines = [];
    lines.push('Context: ' + ctxLabel);
    lines.push('Approx time: ' + (data.approx_seconds || '?') + ' seconds · ' + (data.word_count || '?') + ' words');
    lines.push('');
    lines.push('SPEECH:');
    lines.push((data.speech || '').trim());
    lines.push('');
    if (data.hook) {
      lines.push('Hook (' + (data.hook.type || 'scene') + '): ' + (data.hook.line || ''));
      if (data.hook.why_it_works) lines.push('  Why it works: ' + data.hook.why_it_works);
      lines.push('');
    }
    if (Array.isArray(data.rules_applied)) {
      lines.push('FOUR RULES APPLIED:');
      const labels = {
        never_start_with_name:   '1. Never start with your name',
        lead_with_hook:          '2. Lead with a hook',
        tailor_to_context:       '3. Tailor to this room',
        name_and_question_last:  '4. Name and a question come last',
      };
      data.rules_applied.forEach(r => {
        lines.push('  ' + (labels[r.rule] || r.rule) + ': ' + (r.applied_as || ''));
      });
      lines.push('');
    }
    if (data.close_question) {
      lines.push('Close on: ' + data.close_question);
      lines.push('');
    }
    if (data.delivery_notes) {
      lines.push('Delivery notes: ' + data.delivery_notes);
      lines.push('');
    }
    if (data.rationale) {
      lines.push('Rationale: ' + data.rationale);
    }
    return lines.join('\n');
  }

  // ── Pill wiring (for the pitch tool's context selector) ──────────────
  function wirePills(group) {
    if (!group) return;
    group.addEventListener('click', (e) => {
      const pill = e.target.closest('.zh-pill');
      if (!pill || !group.contains(pill)) return;
      group.querySelectorAll('.zh-pill').forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');
    });
  }

  // ── Generate flow (one path, works for any registered tool) ──────────
  async function generate(toolKey, form) {
    const cfg = TOOLS[toolKey];
    if (!cfg) return;
    const submitBtn = form.querySelector('[data-gt="generate"]');
    const resultEl  = form.querySelector('[data-gt="result"]');

    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      if (resultEl) {
        resultEl.className = 'zh-result is-error';
        resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal first. Grant works from the brief, not from scratch.</div>';
      }
      return;
    }
    const name = (ss(KEY_NAME) || '').trim();

    if (submitBtn) submitBtn.disabled = true;
    const origLabel = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) submitBtn.textContent = 'Working...';
    if (resultEl) {
      resultEl.className = 'zh-result is-loading';
      resultEl.innerHTML = '<div class="zh-result-msg">' + escapeHtml(cfg.loadingMsg) + '</div>';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    try {
      const body = Object.assign({ brief, name }, cfg.bodyForFetch(form) || {});
      const resp = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(toolKey + ' ' + resp.status + ' ' + text.slice(0, 200));
      }
      const data = await resp.json();
      const title = cfg.title ? cfg.title(data) : '';

      // Annotate the context with its human-readable label for the pitch tool.
      if (toolKey === 'pitch' && data.context) {
        data.context_label = CONTEXT_LABELS[data.context] || data.context;
      }

      // Save BEFORE rendering so the brief panel reflects the addition
      // while the visitor reads the result for the first time.
      const plain = cfg.formatForBrief(data);
      appendToBrief(plain, { brieflabel: cfg.brieflabel, title, rationale: data.rationale || '' });

      if (resultEl) {
        resultEl.className = 'zh-result is-ready';
        resultEl.innerHTML = cfg.render(data);

        // Wire up any copy buttons inside the result.
        const copyBtn = resultEl.querySelector('[data-gt="copy-speech"]');
        if (copyBtn) {
          copyBtn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(String(data.speech || ''));
              copyBtn.textContent = 'Copied';
              setTimeout(() => { copyBtn.textContent = 'Copy speech'; }, 1800);
            } catch(_){}
          });
        }
      }
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-grant-tools]', toolKey, msg);
      if (resultEl) {
        resultEl.className = 'zh-result is-error';
        resultEl.innerHTML = '<div class="zh-result-msg">' + (
          isTimeout
            ? 'Grant took too long. Try again, or refresh the page.'
            : 'Could not generate. Try again.'
        ) + '</div>';
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = origLabel;
      }
    }
  }

  function init() {
    // Find every tool card and wire it up.
    const cards = document.querySelectorAll('[data-gt-tool]');
    cards.forEach(card => {
      const toolKey = card.dataset.gtTool;
      if (!TOOLS[toolKey]) return;
      const submitBtn = card.querySelector('[data-gt="generate"]');
      if (submitBtn) {
        submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(toolKey, card); });
      }
      // Wire context pills if present (pitch tool only).
      const ctxPills = card.querySelector('[data-gt="context"]');
      if (ctxPills) wirePills(ctxPills);
    });

    rerenderBriefPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
