/* ─────────────────────────────────────────────────────────────────────────────
   tg-grant-drill.js — Judge-question Drill panel for Grant's office.

   Visitor picks ONE judge from the 9-judge panel, hits Start, and runs
   rounds with that judge. Each round: a question in the judge's voice ->
   visitor answers -> Grant scores it (weak/okay/solid/strong) + names one
   tactical improvement + asks the next question.

   Posts to the existing /.netlify/functions/tg-ep-chat endpoint with a
   "drill" object in the body. The function's drill branch returns a
   different shape ({ drill: {...} }) than the standard chat path.

   At end of drill, the visitor can append a session summary to their
   brief + revision log (rounds played, scores, the judge drilled,
   when to drill them again).

   SessionStorage:
     tg_visitor_brief   - read for context, mutated on session save
     tg_visitor_name    - read for vocative
     tg_ep_revisions    - revision log (drill summary appended here)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const ENDPOINT = '/.netlify/functions/tg-ep-chat';
  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 30000;

  // The 9 judges. id matches judges_master.json; label is the display
  // name the panel shows on each pill.
  const JUDGES = [
    { id: 'selene_voss',    label: 'Selene',  beat: 'AI & emerging tech' },
    { id: 'marcus_holt',    label: 'Marcus',  beat: 'finance / exit math' },
    { id: 'priya_anand',    label: 'Priya',   beat: 'health / clinical' },
    { id: 'raymond_chen',   label: 'Raymond', beat: 'ops / unit economics' },
    { id: 'astrid_lund',    label: 'Astrid',  beat: 'legal / IP' },
    { id: 'osei_mensah',    label: 'Osei',    beat: 'research / data' },
    { id: 'grace_nakamura', label: 'Grace',   beat: 'national security / dual-use' },
    { id: 'devon_sloane',   label: 'Devon',   beat: 'media / narrative' },
    { id: 'cassidy_mercer', label: 'Cassidy', beat: 'behavior / read' },
  ];

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

  // ── State ─────────────────────────────────────────────────────────────
  // Single-session state. The panel is one-judge-at-a-time; switching
  // judges starts a new session.
  const state = {
    isOpen:       false,         // is the drill panel visible (after Start)
    judgeId:      null,
    judgeLabel:   null,
    round:        0,             // 0 = pre-first-question; 1 = first Q presented; etc.
    lastQuestion: null,
    lastAnswer:   null,
    history:      [],            // array of { round, question, answer, score, improvement }
    inFlight:     false,
  };

  // ── DOM refs (lazily resolved) ────────────────────────────────────────
  let rootEl, judgesEl, startBtn, sessionEl, headerEl, historyEl, currentEl,
      answerEl, submitBtn, endBtn, switchBtn, statusEl;

  function resolveRefs() {
    rootEl    = document.querySelector('[data-grant-drill]');
    if (!rootEl) return false;
    judgesEl  = rootEl.querySelector('[data-gd="judges"]');
    startBtn  = rootEl.querySelector('[data-gd="start"]');
    sessionEl = rootEl.querySelector('[data-gd="session"]');
    headerEl  = rootEl.querySelector('[data-gd="header"]');
    historyEl = rootEl.querySelector('[data-gd="history"]');
    currentEl = rootEl.querySelector('[data-gd="current"]');
    answerEl  = rootEl.querySelector('[data-gd="answer"]');
    submitBtn = rootEl.querySelector('[data-gd="submit"]');
    endBtn    = rootEl.querySelector('[data-gd="end"]');
    switchBtn = rootEl.querySelector('[data-gd="switch"]');
    statusEl  = rootEl.querySelector('[data-gd="status"]');
    return true;
  }

  function selectedJudge() {
    if (!judgesEl) return null;
    const active = judgesEl.querySelector('.gd-pill.is-active');
    if (!active) return null;
    const id = active.getAttribute('data-judge-id');
    return JUDGES.find(j => j.id === id) || null;
  }

  // ── Render ────────────────────────────────────────────────────────────
  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function renderJudgePills() {
    if (!judgesEl) return;
    judgesEl.innerHTML = JUDGES.map(j =>
      '<button type="button" class="gd-pill" data-judge-id="' + escapeHtml(j.id) + '" title="' + escapeHtml(j.beat) + '">'
      + escapeHtml(j.label)
      + '<span class="gd-pill-beat">' + escapeHtml(j.beat) + '</span>'
      + '</button>'
    ).join('');
  }

  function renderHeader() {
    if (!headerEl) return;
    if (!state.judgeId) { headerEl.innerHTML = ''; return; }
    headerEl.innerHTML = ''
      + '<div class="gd-header-judge">Drilling on <strong>' + escapeHtml(state.judgeLabel || '') + '</strong></div>'
      + '<div class="gd-header-round">Round <strong>' + (state.round || 1) + '</strong></div>';
  }

  function renderHistory() {
    if (!historyEl) return;
    historyEl.innerHTML = state.history.map(h => ''
      + '<article class="gd-past">'
      +   '<div class="gd-past-meta">Round ' + h.round
      +     (h.score ? ' &middot; <span class="gd-score gd-score-' + escapeHtml(h.score) + '">' + escapeHtml(h.score) + '</span>' : '')
      +   '</div>'
      +   '<div class="gd-past-q">' + escapeHtml(h.question) + '</div>'
      +   '<div class="gd-past-a">' + escapeHtml(h.answer) + '</div>'
      +   (h.improvement ? '<div class="gd-past-fix"><span class="wt-mini-label">Fix:</span> ' + escapeHtml(h.improvement) + '</div>' : '')
      + '</article>'
    ).join('');
  }

  function renderCurrent(question, score, improvement) {
    if (!currentEl) return;
    currentEl.innerHTML = ''
      + (score
          ? '<div class="gd-feedback">'
            +   '<span class="gd-score gd-score-' + escapeHtml(score) + '">' + escapeHtml(score) + '</span>'
            +   (improvement ? ' <span class="gd-fix">' + escapeHtml(improvement) + '</span>' : '')
            + '</div>'
          : '')
      + '<div class="gd-question">' + escapeHtml(question) + '</div>';
  }

  function setSessionMode(on) {
    if (!sessionEl) return;
    sessionEl.classList.toggle('is-open', !!on);
    state.isOpen = !!on;
  }

  // ── Fetch (drill request) ─────────────────────────────────────────────
  async function fetchDrillRound(opts) {
    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      setStatus('Drop your brief in from the welcome modal first. Grant drills on the actual brief.', true);
      return null;
    }
    const name = (ss(KEY_NAME) || '').trim();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ep_id: 'grant_ellis',
          brief,
          name,
          drill: opts,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error('drill ' + resp.status + ' ' + text.slice(0, 200));
      }
      const data = await resp.json();
      if (!data || !data.drill) throw new Error('no drill in response');
      return data.drill;
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-grant-drill]', msg);
      setStatus(isTimeout ? 'Grant took too long. Try again.' : 'Could not run that round. Try again.', true);
      return null;
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────
  async function startDrill() {
    const judge = selectedJudge();
    if (!judge) {
      setStatus('Pick a judge first.', true);
      return;
    }
    state.judgeId      = judge.id;
    state.judgeLabel   = judge.label;
    state.round        = 0;
    state.lastQuestion = null;
    state.lastAnswer   = null;
    state.history      = [];
    setSessionMode(true);
    setStatus(judge.label + ' is loading the first question.');
    renderHeader();
    renderHistory();
    if (currentEl) currentEl.innerHTML = '<div class="gd-question gd-question-loading">' + escapeHtml(judge.label) + ' is thinking...</div>';
    state.inFlight = true;

    const drill = await fetchDrillRound({
      judge_id:      judge.id,
      round:         1,
      last_question: null,
      last_answer:   null,
    });
    state.inFlight = false;
    if (!drill) return;

    state.round = 1;
    state.lastQuestion = drill.next_question;
    renderHeader();
    renderCurrent(drill.next_question, null, null);
    setStatus('Your answer.');
    if (answerEl) { answerEl.value = ''; answerEl.focus(); }
  }

  async function submitAnswer() {
    if (state.inFlight) return;
    if (!state.judgeId || !state.lastQuestion) {
      setStatus('Start the drill first.', true);
      return;
    }
    const answer = (answerEl && answerEl.value || '').trim();
    if (!answer) {
      setStatus('Type an answer, even a rough one. Grant cannot score air.', true);
      if (answerEl) answerEl.focus();
      return;
    }
    state.lastAnswer = answer;
    state.inFlight = true;
    setStatus('Grant is scoring and rewriting the next question.');
    if (submitBtn) submitBtn.disabled = true;

    const drill = await fetchDrillRound({
      judge_id:      state.judgeId,
      round:         state.round + 1,
      last_question: state.lastQuestion,
      last_answer:   answer,
    });
    state.inFlight = false;
    if (submitBtn) submitBtn.disabled = false;
    if (!drill) return;

    // Push the just-finished round onto history.
    state.history.push({
      round:       state.round,
      question:    state.lastQuestion,
      answer:      answer,
      score:       drill.score,
      improvement: drill.improvement,
    });
    state.round += 1;
    state.lastQuestion = drill.next_question;
    if (answerEl) { answerEl.value = ''; answerEl.focus(); }

    renderHeader();
    renderHistory();
    renderCurrent(drill.next_question, drill.score, drill.improvement);
    setStatus(drill.drill_done ? 'Grant says you have it. Save the session if you want to take the notes with you.' : 'Your answer.');
  }

  // End drill = wrap up. Optionally write a session summary to the brief
  // + revision log so the rounds are captured in the deliverable.
  function endDrill() {
    if (!state.judgeId) { setSessionMode(false); return; }
    const ok = state.history.length > 0
      ? window.confirm('Save this drill session to your brief? You drilled ' + state.history.length + ' round' + (state.history.length === 1 ? '' : 's') + ' with ' + state.judgeLabel + '.')
      : false;
    if (ok) {
      const lines = [];
      lines.push('JUDGE: ' + state.judgeLabel);
      lines.push('ROUNDS: ' + state.history.length);
      lines.push('');
      state.history.forEach((h, i) => {
        lines.push('--- Round ' + (i + 1) + (h.score ? '  [' + h.score.toUpperCase() + ']' : '') + ' ---');
        lines.push('Q: ' + h.question);
        lines.push('A: ' + h.answer);
        if (h.improvement) lines.push('Fix: ' + h.improvement);
        lines.push('');
      });
      const plainText = lines.join('\n').trim();
      const oldBrief = (ss(KEY_BRIEF) || '').trim();
      const header = '[Drill Session: ' + state.judgeLabel + '] ' + state.history.length + ' rounds';
      const block = header + '\n\n' + plainText;
      ssSet(KEY_BRIEF, oldBrief ? (oldBrief + '\n\n' + block) : block);

      const revisions = ssJson(KEY_REVISIONS, []);
      revisions.push({
        ep_id:         'grant_ellis',
        operation:     'append',
        section_label: 'Drill Session: ' + state.judgeLabel + ' (' + state.history.length + ' rounds)',
        before:        '',
        after:         block,
        rationale:     'Grant ran a structured drill on the visitor for ' + state.judgeLabel + '.',
        accepted_at:   Date.now(),
      });
      ssSet(KEY_REVISIONS, JSON.stringify(revisions));

      // Re-render brief panel (same lightweight approach used by tg-arjun-tools).
      const briefEl = document.querySelector('[data-tg-office="brief"]');
      if (briefEl) {
        briefEl.textContent = ss(KEY_BRIEF) || '';
        briefEl.removeAttribute('data-empty');
      }
    }
    // Reset and close.
    state.judgeId = null; state.judgeLabel = null;
    state.round = 0; state.lastQuestion = null; state.lastAnswer = null;
    state.history = [];
    if (currentEl) currentEl.innerHTML = '';
    if (historyEl) historyEl.innerHTML = '';
    if (headerEl)  headerEl.innerHTML  = '';
    setStatus('');
    setSessionMode(false);
  }

  function switchJudge() {
    // Same effect as End, but bypasses the save prompt - useful mid-flow.
    state.judgeId = null; state.judgeLabel = null;
    state.round = 0; state.lastQuestion = null; state.lastAnswer = null;
    state.history = [];
    if (currentEl) currentEl.innerHTML = '';
    if (historyEl) historyEl.innerHTML = '';
    if (headerEl)  headerEl.innerHTML  = '';
    setStatus('Pick a different judge and start a fresh drill.');
    setSessionMode(false);
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    if (!resolveRefs()) return;
    renderJudgePills();

    judgesEl.addEventListener('click', (e) => {
      const pill = e.target.closest('.gd-pill');
      if (!pill || !judgesEl.contains(pill)) return;
      judgesEl.querySelectorAll('.gd-pill').forEach(p => p.classList.remove('is-active'));
      pill.classList.add('is-active');
      setStatus('');
    });
    if (startBtn)  startBtn.addEventListener('click', (e) => { e.preventDefault(); startDrill(); });
    if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); submitAnswer(); });
    if (endBtn)    endBtn.addEventListener('click', (e) => { e.preventDefault(); endDrill(); });
    if (switchBtn) switchBtn.addEventListener('click', (e) => { e.preventDefault(); switchJudge(); });

    // Cmd/Ctrl + Enter submits the current answer.
    if (answerEl) {
      answerEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submitAnswer();
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
