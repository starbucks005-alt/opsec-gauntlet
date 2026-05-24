/* ─────────────────────────────────────────────────────────────────────────────
   tg-idea-generator.js — Homepage "Help me find one" Path B modal.

   Pure tool, no character. Stepped UI:
     Step 1 - What is your world?            (radio)
     Step 2 - What stops you?                (radio - routes helper tier)
     Step 3 - How far along are you?         (radio)
     Step 4 - Describe it in your own words. (text)
     Step 5 - Loading / generating
     Step 6 - Concept seed + Wren handoff

   Trigger: any element with [data-tg-idea-open].

   Backend: POST /.netlify/functions/tg-idea-generator with the four answers.
   Returns { seed, blocker }. Seed is rendered as-is. Blocker is used to
   highlight which helper picks up next (downstream routing, not built yet).

   Self-contained: injects its own styles, builds its own DOM, plays Wren's
   role voice through the existing tg-voice endpoint when the seed lands.
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  // Voice cache-buster matches tg-voice.js so Wren is fresh.
  const VOICE_VERSION = '2026-05-23-v5';
  const VOICE_ENDPOINT = '/.netlify/functions/tg-voice';
  const SEED_ENDPOINT  = '/.netlify/functions/tg-idea-generator';

  const Q1 = {
    key: 'world',
    title: 'What is your world?',
    sub:   'Pick the closest. You can pick Other if nothing fits.',
    type:  'radio',
    options: [
      { value: 'Technology',              label: 'Technology' },
      { value: 'Health and science',      label: 'Health and science' },
      { value: 'Business and finance',    label: 'Business and finance' },
      { value: 'Law and policy',          label: 'Law and policy' },
      { value: 'Media and entertainment', label: 'Media and entertainment' },
      { value: 'Education',               label: 'Education' },
      { value: '__other__',               label: 'Other', other: true },
    ],
  };

  const Q2 = {
    key: 'blocker',
    title: 'What stops you from making it happen?',
    sub:   'Whichever one feels truest right now.',
    type:  'radio',
    options: [
      { value: 'I do not know if anyone actually wants it',         label: 'I do not know if anyone actually wants it' },
      { value: 'I would not know where to start building it',       label: 'I would not know where to start building it' },
      { value: 'I do not know how to talk about it or sell it',     label: 'I do not know how to talk about it or sell it' },
      { value: 'I am not sure it is original enough',               label: 'I am not sure it is original enough' },
      { value: 'I do not have the time or resources yet',           label: 'I do not have the time or resources yet' },
      { value: '__other__',                                         label: 'Other', other: true },
    ],
  };

  const Q3 = {
    key: 'stage',
    title: 'How far along are you?',
    sub:   '',
    type:  'radio',
    options: [
      { value: 'Just a feeling nothing written down yet',     label: 'Just a feeling, nothing written down yet' },
      { value: 'I have described it to someone',              label: 'I have described it to someone' },
      { value: 'I have notes or a rough outline',             label: 'I have notes or a rough outline' },
      { value: 'I have tried to build or research it already',label: 'I have tried to build or research it already' },
    ],
  };

  const Q4 = {
    key: 'description',
    title: 'Describe it in your own words.',
    sub:   'No pressure on grammar. Plain English is best.',
    type:  'textarea',
    placeholder: 'One sentence is enough to start.',
  };

  const QUESTIONS = [Q1, Q2, Q3, Q4];

  const state = {
    step: 0,                  // 0..3 questions, 4 loading, 5 result
    answers: { world:'', blocker:'', stage:'', description:'' },
    otherTexts: { world:'', blocker:'' },
    framing: null,            // Wren's one-line reaction before the seed
    seed: null,
  };

  // ── Styles ───────────────────────────────────────────────────────────────
  function injectStyles(){
    if (document.getElementById('tg-ideagen-styles')) return;
    const s = document.createElement('style');
    s.id = 'tg-ideagen-styles';
    s.textContent = `
      .tg-ig-backdrop{
        position:fixed;inset:0;background:rgba(8,6,4,0.78);
        backdrop-filter:blur(6px);
        display:none;align-items:flex-start;justify-content:center;
        padding:5vh 1.5rem;z-index:700;overflow-y:auto;
      }
      .tg-ig-backdrop.is-open{display:flex;}
      .tg-ig-modal{
        background:#0a0a0a;border:1px solid var(--gold,#b8922a);
        max-width:680px;width:100%;
        padding:1.6rem 1.9rem 1.5rem;
        position:relative;
        box-shadow:0 24px 60px -20px rgba(0,0,0,0.85),
                   0 0 60px -10px rgba(184,146,42,0.25);
        font-family:'Cormorant Garamond',serif;color:#e8dece;
      }
      .tg-ig-close{
        position:absolute;top:0.5rem;right:0.6rem;
        background:rgba(10,10,10,0.6);border:none;color:#f4ede0;
        font-size:1.5rem;line-height:1;
        cursor:pointer;padding:0.3rem 0.6rem;border-radius:50%;
        z-index:4;
      }
      .tg-ig-close:hover{color:var(--gold,#b8922a);background:rgba(10,10,10,0.85);}

      .tg-ig-progress{
        display:flex;gap:0.4rem;align-items:center;
        margin-bottom:1.2rem;
      }
      .tg-ig-progress-pip{
        flex:1;height:3px;background:rgba(184,146,42,0.18);
        transition:background 0.25s;
      }
      .tg-ig-progress-pip.is-done{background:var(--gold,#b8922a);}
      .tg-ig-progress-pip.is-current{background:var(--gold-light,#d4aa4a);}
      .tg-ig-progress-label{
        font-family:'DM Mono',monospace;font-size:0.55rem;letter-spacing:0.24em;
        text-transform:uppercase;color:#a89c88;white-space:nowrap;
      }

      .tg-ig-eyebrow{
        font-family:'DM Mono',monospace;font-size:0.55rem;letter-spacing:0.24em;
        text-transform:uppercase;color:var(--gold,#b8922a);margin-bottom:0.5rem;
      }
      .tg-ig-title{
        font-family:'Playfair Display',serif;font-size:1.7rem;font-weight:700;
        color:#f4ede0;line-height:1.2;margin-bottom:0.45rem;
      }
      .tg-ig-title em{font-style:italic;color:var(--gold-light,#d4aa4a);}
      .tg-ig-sub{
        color:#a89c88;font-style:italic;font-size:1rem;line-height:1.55;
        margin-bottom:1.2rem;
      }

      .tg-ig-options{display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1.4rem;}
      .tg-ig-option{
        display:flex;align-items:flex-start;gap:0.7rem;
        padding:0.7rem 0.9rem;
        border:1px solid rgba(184,146,42,0.25);background:rgba(0,0,0,0.45);
        cursor:pointer;transition:border-color 0.2s,background 0.2s;
        font-size:1rem;line-height:1.4;color:#e8dece;
      }
      .tg-ig-option:hover{border-color:var(--gold,#b8922a);background:rgba(184,146,42,0.06);}
      .tg-ig-option.is-selected{
        border-color:var(--gold,#b8922a);background:rgba(184,146,42,0.12);
        color:#f4ede0;
      }
      .tg-ig-option input[type="radio"]{
        appearance:none;-webkit-appearance:none;
        width:16px;height:16px;border-radius:50%;
        border:1.5px solid rgba(184,146,42,0.5);
        margin-top:0.18rem;flex:0 0 16px;
        position:relative;cursor:pointer;background:transparent;
      }
      .tg-ig-option.is-selected input[type="radio"]{
        border-color:var(--gold-light,#d4aa4a);
      }
      .tg-ig-option.is-selected input[type="radio"]::after{
        content:'';position:absolute;inset:3px;border-radius:50%;
        background:var(--gold-light,#d4aa4a);
      }

      .tg-ig-other-row{
        display:none;padding:0 0.9rem 0.9rem;
        border:1px solid rgba(184,146,42,0.25);border-top:none;
        background:rgba(0,0,0,0.45);margin-top:-0.5rem;
      }
      .tg-ig-other-row.is-active{display:block;}
      .tg-ig-other-row input{
        width:100%;background:rgba(255,255,255,0.04);
        border:1px solid rgba(184,146,42,0.25);
        color:#e8dece;padding:0.55rem 0.7rem;
        font-family:'Cormorant Garamond',serif;font-size:0.95rem;
        outline:none;
      }
      .tg-ig-other-row input:focus{border-color:var(--gold,#b8922a);}

      .tg-ig-textarea{
        width:100%;min-height:150px;
        background:rgba(255,255,255,0.04);
        border:1px solid rgba(184,146,42,0.3);
        color:#e8dece;padding:0.9rem 1rem;
        font-family:'Cormorant Garamond',serif;font-size:1.05rem;line-height:1.55;
        outline:none;resize:vertical;margin-bottom:1.2rem;
      }
      .tg-ig-textarea::placeholder{color:#7d735f;font-style:italic;}
      .tg-ig-textarea:focus{border-color:var(--gold,#b8922a);}

      .tg-ig-nav{
        display:flex;justify-content:space-between;align-items:center;gap:0.8rem;
        padding-top:1rem;border-top:1px solid rgba(184,146,42,0.25);
      }
      .tg-ig-btn{
        background:transparent;border:1px solid rgba(184,146,42,0.4);
        color:#a89c88;
        font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:0.2em;
        text-transform:uppercase;padding:0.7rem 1.3rem;cursor:pointer;
        transition:border-color 0.2s,color 0.2s,background 0.2s;
      }
      .tg-ig-btn:hover:not(:disabled){border-color:var(--gold,#b8922a);color:var(--gold,#b8922a);}
      .tg-ig-btn:disabled{opacity:0.35;cursor:not-allowed;}
      .tg-ig-btn-primary{
        background:var(--gold,#b8922a);border-color:var(--gold,#b8922a);
        color:#0a0a0a;font-weight:700;
      }
      .tg-ig-btn-primary:hover:not(:disabled){
        background:var(--gold-light,#d4aa4a);border-color:var(--gold-light,#d4aa4a);
      }

      .tg-ig-loading{
        text-align:center;padding:2rem 1rem;
      }
      .tg-ig-loading-spinner{
        width:48px;height:48px;border-radius:50%;
        border:2px solid rgba(184,146,42,0.25);border-top-color:var(--gold-light,#d4aa4a);
        margin:0 auto 1.2rem;animation:tg-ig-spin 0.9s linear infinite;
      }
      @keyframes tg-ig-spin{to{transform:rotate(360deg);}}
      .tg-ig-loading-text{
        font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:0.24em;
        text-transform:uppercase;color:var(--gold-light,#d4aa4a);
      }

      .tg-ig-result{padding:0.3rem 0 0.2rem;}
      .tg-ig-framing{
        font-family:'Playfair Display',serif;font-style:italic;
        font-size:1.05rem;line-height:1.55;color:var(--gold-light,#d4aa4a);
        margin:0 0 0.9rem;padding:0 0.2rem;
      }
      .tg-ig-seed{
        font-family:'Playfair Display',serif;font-size:1.2rem;line-height:1.55;
        color:#f4ede0;
        padding:1.5rem 1.6rem;
        background:rgba(184,146,42,0.06);
        border-left:3px solid var(--gold,#b8922a);
        margin-bottom:1.5rem;
      }
      .tg-ig-handoff{
        display:flex;gap:1rem;align-items:center;
        padding:1rem;
        border:1px solid rgba(184,146,42,0.25);background:rgba(0,0,0,0.45);
        margin-bottom:1.3rem;
      }
      .tg-ig-handoff-portrait{
        width:64px;height:64px;flex:0 0 64px;overflow:hidden;
        border:1px solid rgba(184,146,42,0.35);background:#0a0a0a;
      }
      .tg-ig-handoff-portrait img{
        width:100%;height:100%;object-fit:cover;object-position:center top;
        display:block;
      }
      .tg-ig-handoff-text{flex:1;}
      .tg-ig-handoff-name{
        font-family:'Playfair Display',serif;font-size:1.1rem;font-weight:700;
        color:#f4ede0;margin-bottom:0.2rem;
      }
      .tg-ig-handoff-line{
        font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:0.18em;
        text-transform:uppercase;color:var(--gold-light,#d4aa4a);
      }

      @media (max-width:600px){
        .tg-ig-modal{padding:1.3rem 1.2rem 1.2rem;}
        .tg-ig-title{font-size:1.4rem;}
        .tg-ig-seed{font-size:1.05rem;padding:1.1rem 1.2rem;}
      }
    `;
    document.head.appendChild(s);
  }

  // ── DOM ─────────────────────────────────────────────────────────────────
  let backdrop = null;
  let bodyEl   = null;
  let navEl    = null;
  let progEl   = null;

  function buildShell(){
    if (backdrop) return;
    backdrop = document.createElement('div');
    backdrop.className = 'tg-ig-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', 'Idea generator');
    backdrop.innerHTML = `
      <div class="tg-ig-modal">
        <button class="tg-ig-close" aria-label="Close">×</button>
        <div class="tg-ig-progress" id="tg-ig-progress"></div>
        <div id="tg-ig-body"></div>
        <div class="tg-ig-nav" id="tg-ig-nav"></div>
      </div>
    `;
    document.body.appendChild(backdrop);
    bodyEl = backdrop.querySelector('#tg-ig-body');
    navEl  = backdrop.querySelector('#tg-ig-nav');
    progEl = backdrop.querySelector('#tg-ig-progress');

    backdrop.querySelector('.tg-ig-close').addEventListener('click', close);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && backdrop.classList.contains('is-open')) close();
    });
  }

  function open(){
    injectStyles();
    buildShell();
    state.step = 0;
    state.answers = { world:'', blocker:'', stage:'', description:'' };
    state.otherTexts = { world:'', blocker:'' };
    state.framing = null;
    state.seed = null;
    backdrop.classList.add('is-open');
    render();
  }

  function close(){
    if (backdrop) backdrop.classList.remove('is-open');
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function render(){
    renderProgress();
    if (state.step < QUESTIONS.length) renderQuestion();
    else if (state.step === QUESTIONS.length) renderLoading();
    else renderResult();
  }

  function renderProgress(){
    if (!progEl) return;
    progEl.innerHTML = '';
    QUESTIONS.forEach((_, i) => {
      const pip = document.createElement('div');
      pip.className = 'tg-ig-progress-pip';
      if (i < state.step) pip.classList.add('is-done');
      else if (i === state.step) pip.classList.add('is-current');
      progEl.appendChild(pip);
    });
    const label = document.createElement('div');
    label.className = 'tg-ig-progress-label';
    if (state.step < QUESTIONS.length) label.textContent = `Step ${state.step + 1} of ${QUESTIONS.length}`;
    else if (state.step === QUESTIONS.length) label.textContent = 'Generating';
    else label.textContent = 'Done';
    progEl.appendChild(label);
  }

  function renderQuestion(){
    const q = QUESTIONS[state.step];
    const current = state.answers[q.key];

    let html = `
      <div class="tg-ig-eyebrow">Idea Generator</div>
      <h2 class="tg-ig-title">${escapeHtml(q.title)}</h2>
      ${q.sub ? `<p class="tg-ig-sub">${escapeHtml(q.sub)}</p>` : ''}
    `;

    if (q.type === 'radio'){
      html += '<div class="tg-ig-options">';
      q.options.forEach((opt, i) => {
        const isSel = opt.other
          ? current === '__other__'
          : current === opt.value;
        html += `
          <label class="tg-ig-option ${isSel ? 'is-selected' : ''}" data-opt-index="${i}">
            <input type="radio" name="tg-ig-${q.key}" ${isSel ? 'checked' : ''}>
            <span>${escapeHtml(opt.label)}</span>
          </label>
        `;
        if (opt.other){
          const otherVal = state.otherTexts[q.key] || '';
          html += `
            <div class="tg-ig-other-row ${isSel ? 'is-active' : ''}" data-other-for="${q.key}">
              <input type="text" placeholder="Tell us in your own words" value="${escapeHtml(otherVal)}">
            </div>
          `;
        }
      });
      html += '</div>';
    }

    if (q.type === 'textarea'){
      html += `
        <textarea class="tg-ig-textarea" placeholder="${escapeHtml(q.placeholder || '')}">${escapeHtml(current)}</textarea>
      `;
    }

    bodyEl.innerHTML = html;
    bindQuestion(q);
    renderNav();
  }

  function bindQuestion(q){
    if (q.type === 'radio'){
      bodyEl.querySelectorAll('.tg-ig-option').forEach((labelEl, i) => {
        labelEl.addEventListener('click', e => {
          // The label/input click both fire; let the label win and stop the
          // input from firing a second click.
          e.preventDefault();
          const opt = q.options[i];
          if (opt.other){
            state.answers[q.key] = '__other__';
          } else {
            state.answers[q.key] = opt.value;
          }
          renderQuestion();
          // Focus the Other input if it just opened.
          if (opt.other){
            const otherInput = bodyEl.querySelector(`[data-other-for="${q.key}"] input`);
            if (otherInput) otherInput.focus();
          }
        });
      });
      const otherInput = bodyEl.querySelector(`[data-other-for="${q.key}"] input`);
      if (otherInput){
        otherInput.addEventListener('input', e => {
          state.otherTexts[q.key] = e.target.value;
          updateNextEnabled();
        });
      }
    }
    if (q.type === 'textarea'){
      const ta = bodyEl.querySelector('.tg-ig-textarea');
      ta.addEventListener('input', e => {
        state.answers[q.key] = e.target.value;
        updateNextEnabled();
      });
      ta.focus();
    }
  }

  function renderNav(){
    const q = QUESTIONS[state.step];
    const isLast = state.step === QUESTIONS.length - 1;
    const backDisabled = state.step === 0;
    const nextDisabled = !isAnswered(q);
    navEl.innerHTML = `
      <button class="tg-ig-btn" id="tg-ig-back" ${backDisabled ? 'disabled' : ''}>Back</button>
      <button class="tg-ig-btn tg-ig-btn-primary" id="tg-ig-next" ${nextDisabled ? 'disabled' : ''}>
        ${isLast ? 'Generate Seed →' : 'Next →'}
      </button>
    `;
    navEl.querySelector('#tg-ig-back').addEventListener('click', () => {
      if (state.step > 0){ state.step--; render(); }
    });
    navEl.querySelector('#tg-ig-next').addEventListener('click', () => {
      if (!isAnswered(q)) return;
      if (isLast) startGeneration();
      else { state.step++; render(); }
    });
  }

  function updateNextEnabled(){
    const q = QUESTIONS[state.step];
    const btn = navEl.querySelector('#tg-ig-next');
    if (btn) btn.disabled = !isAnswered(q);
  }

  function isAnswered(q){
    const val = state.answers[q.key];
    if (q.type === 'textarea') return val && val.trim().length > 0;
    if (q.type === 'radio'){
      if (val === '__other__'){
        const ot = (state.otherTexts[q.key] || '').trim();
        return ot.length > 0;
      }
      return !!val;
    }
    return false;
  }

  function finalAnswer(q){
    const val = state.answers[q.key];
    if (q.type === 'textarea') return val.trim();
    if (val === '__other__') return (state.otherTexts[q.key] || '').trim();
    return val;
  }

  // ── Loading ─────────────────────────────────────────────────────────────
  function renderLoading(){
    bodyEl.innerHTML = `
      <div class="tg-ig-loading">
        <div class="tg-ig-loading-spinner" aria-hidden="true"></div>
        <div class="tg-ig-loading-text">Shaping your concept seed</div>
      </div>
    `;
    navEl.innerHTML = '';
  }

  async function startGeneration(){
    state.step = QUESTIONS.length;
    render();

    const payload = {
      world:       finalAnswer(Q1),
      blocker:     finalAnswer(Q2),
      stage:       finalAnswer(Q3),
      description: finalAnswer(Q4),
    };

    try {
      const resp = await fetch(SEED_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok){
        const detail = await resp.text().catch(() => '');
        throw new Error(`seed ${resp.status}: ${detail || resp.statusText}`);
      }
      const data = await resp.json();
      state.framing = data.framing || '';
      state.seed    = data.seed    || '';
      state.step = QUESTIONS.length + 1;
      render();
    } catch (err) {
      console.warn('[tg-ideagen]', err);
      bodyEl.innerHTML = `
        <div class="tg-ig-eyebrow">Could not reach the generator</div>
        <h2 class="tg-ig-title">Something went wrong.</h2>
        <p class="tg-ig-sub">The concept seed service did not respond. Try again, or skip to the Chamber and tell the judges directly.</p>
      `;
      navEl.innerHTML = `
        <button class="tg-ig-btn" id="tg-ig-retry">Try again</button>
        <a class="tg-ig-btn tg-ig-btn-primary" href="/chamber.html">Enter The Chamber →</a>
      `;
      navEl.querySelector('#tg-ig-retry').addEventListener('click', () => {
        state.step = QUESTIONS.length - 1;
        render();
      });
    }
  }

  // ── Result ──────────────────────────────────────────────────────────────
  function renderResult(){
    bodyEl.innerHTML = `
      <div class="tg-ig-eyebrow">Your concept seed</div>
      <h2 class="tg-ig-title">Wren is <em>reading it back</em>.</h2>
      <div class="tg-ig-result">
        <div class="tg-ig-handoff">
          <div class="tg-ig-handoff-portrait">
            <img src="Helpers/Wren_Profile.jpg" alt="Wren Calloway">
          </div>
          <div class="tg-ig-handoff-text">
            <div class="tg-ig-handoff-name">Wren Calloway</div>
            <div class="tg-ig-handoff-line" id="tg-ig-wren-status">Speaking ▶</div>
          </div>
        </div>
        ${state.framing ? `<p class="tg-ig-framing">${escapeHtml(state.framing)}</p>` : ''}
        <div class="tg-ig-seed">${escapeHtml(state.seed)}</div>
      </div>
    `;
    navEl.innerHTML = `
      <button class="tg-ig-btn" id="tg-ig-replay">Play again</button>
      <a class="tg-ig-btn tg-ig-btn-primary" href="/Helpers/wren-scout.html">Open Wren's profile →</a>
    `;
    navEl.querySelector('#tg-ig-replay').addEventListener('click', () => {
      playWrenReadback();
    });

    // Wren actually reads the seed back. POST to the voice function with
    // framing + seed as a single text payload, voiced as Wren.
    playWrenReadback();
  }

  let wrenAudio = null;
  let wrenAudioUrl = null;
  function setWrenStatus(text){
    const el = document.getElementById('tg-ig-wren-status');
    if (el) el.textContent = text;
  }

  async function playWrenReadback(){
    // Stop any previous play (replay case).
    if (wrenAudio){
      try { wrenAudio.pause(); } catch(_){}
      wrenAudio = null;
    }
    if (wrenAudioUrl){
      try { URL.revokeObjectURL(wrenAudioUrl); } catch(_){}
      wrenAudioUrl = null;
    }

    const text = [state.framing, state.seed].filter(Boolean).join(' ').trim();
    if (!text) return;

    setWrenStatus('Warming up...');

    try {
      const resp = await fetch(VOICE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character: 'wren_calloway', text }),
      });
      if (!resp.ok){
        const detail = await resp.text().catch(() => '');
        throw new Error(`voice ${resp.status}: ${detail || resp.statusText}`);
      }
      const blob = await resp.blob();
      wrenAudioUrl = URL.createObjectURL(blob);
      wrenAudio = new Audio(wrenAudioUrl);
      wrenAudio.addEventListener('ended',  () => setWrenStatus('Done. Tap Play again to hear it.'));
      wrenAudio.addEventListener('error',  () => setWrenStatus('Audio failed. Tap Play again.'));
      wrenAudio.addEventListener('playing',() => setWrenStatus('Speaking ▶'));
      try {
        await wrenAudio.play();
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        setWrenStatus('Tap Play again to hear it.');
      }
    } catch (err) {
      console.warn('[tg-ideagen] wren readback failed', err);
      setWrenStatus('Audio unavailable. Read it above.');
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────────
  function escapeHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function init(){
    document.querySelectorAll('[data-tg-idea-open]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        open();
      });
    });
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
