/* ─────────────────────────────────────────────────────────────────────────────
   tg-idea-generator.js — Homepage "Help me find an idea to bring" modal.

   Pure tool, no character. The user does NOT have an idea. The modal
   collects three pieces of context and Claude returns three distinct
   candidate ideas. The user picks one, which auto-fills the intake form
   so they can carry it into the Chamber.

   Stepped UI:
     Step 1 - What world interests you?          (radio)
     Step 2 - What kind of thing frustrates you? (radio)
     Step 3 - What would you bring to building it?(radio)
     Step 4 - Loading / generating
     Step 5 - Three candidate ideas + 'Bring this one to the Chamber'
              + 'Show me 3 more' regenerate

   Trigger: any element with [data-tg-idea-open].

   Backend: POST /.netlify/functions/tg-idea-generator with { world,
   frustration, bring }. Returns { ideas: [{ title, description }, ...] }.

   Self-contained: injects its own styles, builds its own DOM, hands off
   to /intake.html via sessionStorage when the user picks an idea.
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const IDEA_ENDPOINT  = '/.netlify/functions/tg-idea-generator';
  const VOICE_ENDPOINT = '/.netlify/functions/tg-voice';
  const VOICE_VERSION  = '2026-05-23-v5';
  const IVY_CHARACTER  = 'ms_ivy';
  const IVY_PORTRAIT   = 'Helpers/Ivy_Profile.jpg';

  const Q1 = {
    key: 'world',
    title: 'What world interests you?',
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
    key: 'frustration',
    title: 'What kind of thing frustrates you that you wish someone would fix?',
    sub:   'Whichever one feels truest right now.',
    type:  'radio',
    options: [
      { value: 'Something I have to do over and over that wastes time', label: 'Something I have to do over and over that wastes time' },
      { value: 'Something that should be simple but is needlessly hard', label: 'Something that should be simple but is needlessly hard' },
      { value: 'Something nobody has built yet that I wish existed',     label: 'Something nobody has built yet that I wish existed' },
      { value: 'Something that exists but is broken or done badly',     label: 'Something that exists but is broken or done badly' },
      { value: 'Something I know from work that outsiders do not see',  label: 'Something I know from my work that outsiders do not see' },
      { value: '__other__',                                              label: 'Other', other: true },
    ],
  };

  const Q3 = {
    key: 'bring',
    title: 'What would you bring to building it?',
    sub:   'Be honest. There is no wrong answer.',
    type:  'radio',
    options: [
      { value: 'A skill or expertise from my work',          label: 'A skill or expertise from my work' },
      { value: 'A network of people who would care',         label: 'A network of people who would care' },
      { value: 'Money I could put in',                       label: 'Money I could put in' },
      { value: 'Time and patience to grind it out',          label: 'Time and patience to grind it out' },
      { value: 'Just curiosity, no advantage yet',           label: 'Just curiosity, no advantage yet' },
      { value: '__other__',                                  label: 'Other', other: true },
    ],
  };

  const QUESTIONS = [Q1, Q2, Q3];

  const state = {
    step: 0,                 // 0..2 questions, 3 loading, 4 result
    answers: { world:'', frustration:'', bring:'' },
    otherTexts: { world:'', frustration:'', bring:'' },
    ideas: null,
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

      /* Ivy hosting bar: her portrait + name sits at the top of every step
         so the user is talking to a person, not a form. The 'speaking'
         status updates as her voice plays. */
      .tg-ig-host{
        display:flex;align-items:center;gap:0.9rem;
        margin-bottom:1.1rem;padding-bottom:0.9rem;
        border-bottom:1px solid rgba(184,146,42,0.18);
      }
      .tg-ig-host-portrait{
        width:54px;height:54px;flex:0 0 54px;overflow:hidden;
        border:1px solid rgba(184,146,42,0.35);background:#0a0a0a;
      }
      .tg-ig-host-portrait img{
        width:100%;height:100%;object-fit:cover;object-position:center top;
        display:block;
      }
      .tg-ig-host-meta{display:flex;flex-direction:column;gap:0.15rem;flex:1;min-width:0;}
      .tg-ig-host-name{
        font-family:'Playfair Display',serif;font-size:1.05rem;font-weight:700;
        color:#f4ede0;line-height:1.2;
      }
      .tg-ig-host-role{
        font-family:'DM Mono',monospace;font-size:0.55rem;letter-spacing:0.2em;
        text-transform:uppercase;color:var(--gold,#b8922a);
      }
      .tg-ig-host-status{
        font-family:'DM Mono',monospace;font-size:0.5rem;letter-spacing:0.18em;
        text-transform:uppercase;color:var(--text-dim,#a89c88);
      }
      .tg-ig-host-status.is-playing{color:var(--gold-light,#d4aa4a);}

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
      .tg-ig-idea-list{display:flex;flex-direction:column;gap:0.9rem;margin-bottom:1.4rem;}
      .tg-ig-idea{
        padding:1.1rem 1.2rem;
        border:1px solid rgba(184,146,42,0.30);
        background:rgba(184,146,42,0.04);
        border-left:3px solid var(--gold,#b8922a);
        transition:border-color 0.2s,background 0.2s;
      }
      .tg-ig-idea:hover{
        border-left-color:var(--gold-light,#d4aa4a);
        background:rgba(184,146,42,0.07);
      }
      .tg-ig-idea-title{
        font-family:'Playfair Display',serif;font-size:1.25rem;font-weight:700;
        color:#f4ede0;line-height:1.25;margin-bottom:0.5rem;
      }
      .tg-ig-idea-desc{
        font-family:'Cormorant Garamond',serif;font-size:1.02rem;line-height:1.55;
        color:#e8dece;margin-bottom:0.9rem;
      }
      .tg-ig-idea-cta{
        display:inline-flex;align-items:center;gap:0.4rem;
        background:transparent;border:1px solid var(--gold,#b8922a);
        color:var(--gold,#b8922a);
        font-family:'DM Mono',monospace;font-size:0.55rem;letter-spacing:0.2em;
        text-transform:uppercase;font-weight:700;
        padding:0.55rem 0.95rem;cursor:pointer;
        transition:background 0.2s,color 0.2s;
      }
      .tg-ig-idea-cta:hover{background:var(--gold,#b8922a);color:#0a0a0a;}

      @media (max-width:600px){
        .tg-ig-modal{padding:1.3rem 1.2rem 1.2rem;}
        .tg-ig-title{font-size:1.4rem;}
        .tg-ig-idea{padding:0.9rem 1rem;}
        .tg-ig-idea-title{font-size:1.1rem;}
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
        <div class="tg-ig-host" id="tg-ig-host">
          <div class="tg-ig-host-portrait">
            <img src="${IVY_PORTRAIT}" alt="Ms. Ivy" onerror="this.style.display='none'">
          </div>
          <div class="tg-ig-host-meta">
            <div class="tg-ig-host-name">Ms. Ivy</div>
            <div class="tg-ig-host-role">The Librarian</div>
          </div>
          <div class="tg-ig-host-status" id="tg-ig-host-status">Tap to hear her ▶</div>
        </div>
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

    // Click the Ivy bar to play her intro at any time.
    const host = backdrop.querySelector('#tg-ig-host');
    if (host) host.addEventListener('click', e => {
      // Don't fire when the user clicks the close button or somewhere outside the host row.
      if (e.target.closest('.tg-ig-close')) return;
      playIvy('intro');
    });
  }

  function open(){
    injectStyles();
    buildShell();
    state.step = 0;
    state.answers = { world:'', frustration:'', bring:'' };
    state.otherTexts = { world:'', frustration:'', bring:'' };
    state.ideas = null;
    backdrop.classList.add('is-open');
    render();
    // Ivy welcomes the user. If autoplay is blocked (common on first page
    // load before any user gesture), the host bar stays clickable.
    playIvy('intro');
  }

  function close(){
    if (backdrop) backdrop.classList.remove('is-open');
    stopIvy();
  }

  // ── Ivy voice playback ──────────────────────────────────────────────────
  // Plays Ms. Ivy's bio / role / intro through the existing tg-voice
  // endpoint. Mode 'intro' is what we use on modal open; other modes are
  // available for future result-screen narration. Fails silently if her
  // voice_id is not configured yet - the text still works.
  let ivyAudio = null;
  function setIvyStatus(text, isPlaying){
    const el = document.getElementById('tg-ig-host-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-playing', !!isPlaying);
  }
  function stopIvy(){
    if (!ivyAudio) return;
    try { ivyAudio.pause(); ivyAudio.currentTime = 0; } catch(_){}
    ivyAudio = null;
    setIvyStatus('Tap to hear her ▶', false);
  }
  async function playIvy(mode){
    stopIvy();
    setIvyStatus('Warming up...', true);
    const url = `${VOICE_ENDPOINT}?character=${IVY_CHARACTER}&mode=${encodeURIComponent(mode)}&v=${encodeURIComponent(VOICE_VERSION)}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok){
        const detail = await resp.text().catch(() => '');
        throw new Error('voice ' + resp.status + ': ' + (detail || resp.statusText));
      }
      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      ivyAudio = new Audio(objectUrl);
      ivyAudio.addEventListener('playing', () => setIvyStatus('Speaking ▶', true));
      ivyAudio.addEventListener('ended',   () => { stopIvy(); setIvyStatus('Tap to hear her ▶', false); });
      ivyAudio.addEventListener('error',   () => { stopIvy(); setIvyStatus('Audio unavailable', false); });
      try {
        await ivyAudio.play();
      } catch (err) {
        // Autoplay may be blocked until the first user gesture. The host
        // bar is clickable so the user can play her manually.
        if (err && err.name === 'AbortError') return;
        setIvyStatus('Tap to hear her ▶', false);
      }
    } catch (err) {
      console.warn('[tg-ideagen] Ivy audio unavailable', err.message);
      setIvyStatus('Audio coming soon', false);
    }
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
      <div class="tg-ig-eyebrow">Ivy asks</div>
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
        ${isLast ? 'Generate 3 ideas →' : 'Next →'}
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
        <div class="tg-ig-loading-text">Ivy is researching</div>
      </div>
    `;
    navEl.innerHTML = '';
  }

  async function startGeneration(){
    state.step = QUESTIONS.length;
    render();

    const payload = {
      world:       finalAnswer(Q1),
      frustration: finalAnswer(Q2),
      bring:       finalAnswer(Q3),
    };

    try {
      const resp = await fetch(IDEA_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok){
        const detail = await resp.text().catch(() => '');
        throw new Error(`ideas ${resp.status}: ${detail || resp.statusText}`);
      }
      const data = await resp.json();
      state.ideas = Array.isArray(data.ideas) ? data.ideas : [];
      if (state.ideas.length === 0) throw new Error('no ideas returned');
      state.step = QUESTIONS.length + 1;
      render();
    } catch (err) {
      console.warn('[tg-ideagen]', err);
      bodyEl.innerHTML = `
        <div class="tg-ig-eyebrow">Could not reach the generator</div>
        <h2 class="tg-ig-title">Something went wrong.</h2>
        <p class="tg-ig-sub">The idea service did not respond. Try again, or head straight to the Chamber if you have your own idea.</p>
      `;
      navEl.innerHTML = `
        <button class="tg-ig-btn" id="tg-ig-retry">Try again</button>
        <a class="tg-ig-btn tg-ig-btn-primary" href="/intake.html">Skip to intake →</a>
      `;
      navEl.querySelector('#tg-ig-retry').addEventListener('click', () => {
        state.step = QUESTIONS.length - 1;
        render();
      });
    }
  }

  // ── Result ──────────────────────────────────────────────────────────────
  function renderResult(){
    const ideas = state.ideas || [];
    const cards = ideas.map((it, i) => `
      <div class="tg-ig-idea">
        <div class="tg-ig-idea-title">${escapeHtml(it.title)}</div>
        <p class="tg-ig-idea-desc">${escapeHtml(it.description)}</p>
        <button class="tg-ig-idea-cta" type="button" data-pick-idea="${i}">Take it through The Gauntlet →</button>
      </div>
    `).join('');

    bodyEl.innerHTML = `
      <div class="tg-ig-eyebrow">Ivy found three</div>
      <h2 class="tg-ig-title">Pick one. <em>Or send me back for three more.</em></h2>
      <p class="tg-ig-sub">Take one of these ideas through The Gauntlet to polish it, then to the Chamber to be judged...</p>
      <div class="tg-ig-idea-list">${cards}</div>
    `;
    navEl.innerHTML = `
      <button class="tg-ig-btn" id="tg-ig-regen">Show me 3 more</button>
      <button class="tg-ig-btn" id="tg-ig-close-result">Close</button>
    `;

    // Each "Bring this one" pre-fills intake.html via sessionStorage and
    // navigates. Intake reads tg_prefill_title + tg_prefill_description
    // on load and pre-populates the form.
    bodyEl.querySelectorAll('[data-pick-idea]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-pick-idea'), 10);
        const chosen = ideas[i];
        if (!chosen) return;
        try {
          sessionStorage.setItem('tg_prefill_title',       chosen.title);
          sessionStorage.setItem('tg_prefill_description', chosen.description);
        } catch(_){}
        window.location.href = '/intake.html';
      });
    });

    navEl.querySelector('#tg-ig-regen').addEventListener('click', () => {
      startGeneration();
    });
    navEl.querySelector('#tg-ig-close-result').addEventListener('click', close);
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
