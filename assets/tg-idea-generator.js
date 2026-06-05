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
  const INTAKE_ENDPOINT = '/.netlify/functions/tg-intake-submit';
  const VOICE_ENDPOINT = '/.netlify/functions/tg-voice';
  const VOICE_VERSION  = '2026-05-23-v9';
  const IVY_CHARACTER  = 'ms_ivy';
  const IVY_PORTRAIT   = 'Helpers/Ivy_Profile.jpg';
  const ANON_KEY       = 'tg_anon_user_id';
  const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Reuse intake.html's anon-id pattern so submissions tie to the same
  // user across both paths.
  function getOrCreateAnonId(){
    let id = '';
    try { id = localStorage.getItem(ANON_KEY) || ''; } catch(_){}
    if (!UUID_RE.test(id)){
      id = (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
           'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
             const r = (Math.random() * 16) | 0;
             const v = c === 'x' ? r : (r & 0x3) | 0x8;
             return v.toString(16);
           });
      try { localStorage.setItem(ANON_KEY, id); } catch(_){}
    }
    return id;
  }

  // Silently register the idea as a Gauntlet submission so the Chamber has
  // a real submission_id to evaluate. Fire-and-forget; the visitor proceeds
  // into the corridor immediately without seeing this happen.
  async function autoSubmitIdea(chosen){
    if (!chosen || !chosen.title || !chosen.description) return;
    const payload = {
      user_id:     getOrCreateAnonId(),
      title:       String(chosen.title).slice(0, 180),
      description: String(chosen.description).slice(0, 12000),
    };
    try {
      const resp = await fetch(INTAKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        console.warn('[tg-idea-generator] auto-submit failed:', resp.status);
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (!data || !data.id) return;
      try {
        sessionStorage.setItem('tg_submission_id',    data.id);
        sessionStorage.setItem('tg_submission_title', payload.title);
        if (data.requirement_vector){
          sessionStorage.setItem('tg_submission_vector', JSON.stringify(data.requirement_vector));
        }
      } catch(_){}
      console.info('[tg-idea-generator] auto-submitted, submission_id=' + data.id);
    } catch (err) {
      console.warn('[tg-idea-generator] auto-submit error:', err && err.message);
    }
  }

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
    mode: 'basic',           // 'basic' (quick) | 'slr' (gaps + architecture)
    ideas: null,
    keyword_architecture: null,
    ivy_note: '',
    // Optional expertise context. CV pdf is preferred; text is the
    // fallback for visitors without a CV handy. When either is present,
    // the backend grounds ideas in demonstrable expertise instead of
    // generic suggestions in the visitor's stated WORLD.
    expertise: { text: '', pdfBase64: null, pdfName: '', pdfSize: 0 },
    expertiseOpen: false,
  };
  const PDF_MAX_BYTES = 3_500_000; // hard client-side cap (~3.5MB)
  const EXPERTISE_TEXT_CAP = 2000;

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

      /* Mode toggle - BASIC vs SLR. Lives at the top of every step so the
         visitor can switch before they commit. The mode controls which
         engine runs when they hit Generate, not which questions they see.*/
      .tg-ig-mode{
        display:flex;gap:0;margin-bottom:1.1rem;
        border:1px solid rgba(184,146,42,0.3);background:rgba(0,0,0,0.4);
      }
      .tg-ig-mode-tab{
        flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:0.15rem;
        background:transparent;border:none;cursor:pointer;
        padding:0.6rem 0.85rem;
        font-family:'DM Mono',monospace;font-size:0.55rem;letter-spacing:0.2em;
        text-transform:uppercase;color:#a89c88;text-align:left;
        transition:background 0.2s,color 0.2s;border-right:1px solid rgba(184,146,42,0.2);
      }
      .tg-ig-mode-tab:last-child{border-right:none;}
      .tg-ig-mode-tab:hover{color:var(--gold-light,#d4aa4a);}
      .tg-ig-mode-tab.is-active{
        background:rgba(184,146,42,0.10);color:var(--gold,#b8922a);
      }
      .tg-ig-mode-tab-sub{
        font-family:'Cormorant Garamond',serif;font-style:italic;
        font-size:0.85rem;letter-spacing:0;text-transform:none;
        color:#7d735f;line-height:1.3;
      }
      .tg-ig-mode-tab.is-active .tg-ig-mode-tab-sub{color:#a89c88;}
      .tg-ig-mode-tab-row{display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;}
      .tg-ig-mode-chip{
        font-family:'DM Mono',monospace;font-size:0.45rem;letter-spacing:0.22em;
        text-transform:uppercase;color:#0a0a0a;background:var(--gold,#b8922a);
        padding:0.15rem 0.4rem;border-radius:2px;font-weight:700;
      }
      .tg-ig-mode-chip.is-free{
        background:transparent;color:var(--text-dim,#a89c88);
        border:1px solid rgba(184,146,42,0.3);
      }

      /* Expertise panel: optional CV/blurb that grounds idea generation
         in the visitor's demonstrable background. Lives above the
         question content so visitors see it before they pick answers. */
      .tg-ig-exp{
        background:rgba(0,0,0,0.35);border:1px solid rgba(184,146,42,0.25);
        margin-bottom:1.1rem;
      }
      .tg-ig-exp-head{
        display:flex;align-items:center;gap:0.6rem;padding:0.6rem 0.9rem;
        cursor:pointer;user-select:none;
      }
      .tg-ig-exp-head:hover{background:rgba(184,146,42,0.06);}
      .tg-ig-exp-head__icon{
        width:14px;height:14px;color:var(--gold,#b8922a);flex-shrink:0;
        transition:transform 0.18s;
      }
      .tg-ig-exp.is-open .tg-ig-exp-head__icon{transform:rotate(90deg);}
      .tg-ig-exp-head__label{
        font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:0.18em;
        text-transform:uppercase;color:var(--gold-light,#d4aa4a);font-weight:600;
        flex:1;
      }
      .tg-ig-exp-head__status{
        font-family:'Cormorant Garamond',serif;font-style:italic;
        font-size:0.85rem;color:var(--text-dim,#a89c88);
      }
      .tg-ig-exp-head__status.is-loaded{color:#5a9e6f;}
      .tg-ig-exp-body{display:none;padding:0 0.9rem 0.9rem;}
      .tg-ig-exp.is-open .tg-ig-exp-body{display:block;}
      .tg-ig-exp-tabs{
        display:flex;gap:0;margin-bottom:0.6rem;
        border-bottom:1px solid rgba(184,146,42,0.2);
      }
      .tg-ig-exp-tab{
        background:transparent;border:0;cursor:pointer;
        padding:0.45rem 0.8rem;
        font-family:'DM Mono',monospace;font-size:0.58rem;letter-spacing:0.16em;
        text-transform:uppercase;color:var(--text-dim,#a89c88);
        border-bottom:2px solid transparent;
      }
      .tg-ig-exp-tab.is-active{color:#f4ede0;border-bottom-color:var(--gold,#b8922a);}
      .tg-ig-exp-pane{display:none;}
      .tg-ig-exp-pane.is-active{display:block;}
      .tg-ig-exp-drop{
        border:1px dashed rgba(184,146,42,0.4);background:rgba(0,0,0,0.25);
        padding:0.9rem 1rem;text-align:center;cursor:pointer;
        font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:0.14em;
        text-transform:uppercase;color:var(--text-dim,#a89c88);
      }
      .tg-ig-exp-drop:hover{border-color:var(--gold,#b8922a);color:var(--gold-light,#d4aa4a);}
      .tg-ig-exp-drop__hint{
        font-family:'Cormorant Garamond',serif;font-style:italic;font-size:0.78rem;
        color:#7d735f;text-transform:none;letter-spacing:0;margin-top:0.25rem;
      }
      .tg-ig-exp-loaded{
        display:none;align-items:center;gap:0.6rem;
        padding:0.55rem 0.8rem;background:rgba(40,92,77,0.15);
        border-left:3px solid #5a9e6f;
        font-family:'DM Mono',monospace;font-size:0.65rem;color:#f4ede0;
      }
      .tg-ig-exp-loaded.is-visible{display:flex;}
      .tg-ig-exp-loaded__name{flex:1;text-transform:none;letter-spacing:0;}
      .tg-ig-exp-loaded__remove{
        background:transparent;border:1px solid rgba(245,237,224,0.25);
        color:var(--text-dim,#a89c88);font-family:'DM Mono',monospace;
        font-size:0.55rem;letter-spacing:0.14em;text-transform:uppercase;
        padding:0.2rem 0.5rem;cursor:pointer;
      }
      .tg-ig-exp-loaded__remove:hover{color:#f4ede0;border-color:var(--gold,#b8922a);}
      .tg-ig-exp-text{
        width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(184,146,42,0.25);
        color:#f4ede0;padding:0.55rem 0.7rem;
        font-family:'Cormorant Garamond',serif;font-size:0.9rem;line-height:1.5;
        min-height:90px;resize:vertical;
      }
      .tg-ig-exp-text:focus{outline:1px solid var(--gold,#b8922a);outline-offset:-1px;}
      .tg-ig-exp-priv{
        font-family:'Cormorant Garamond',serif;font-style:italic;
        font-size:0.78rem;color:#7d735f;margin-top:0.5rem;line-height:1.4;
      }

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
      /* Keyword architecture strip - Ivy's SLR signature. The anchor and
         the three secondary anchors are visible so the visitor sees the
         space their topic occupies. */
      .tg-ig-ka{
        border:1px solid rgba(184,146,42,0.25);background:rgba(0,0,0,0.4);
        padding:0.9rem 1rem;margin-bottom:1.2rem;
      }
      .tg-ig-ka-label{
        font-family:'DM Mono',monospace;font-size:0.5rem;letter-spacing:0.24em;
        text-transform:uppercase;color:var(--gold,#b8922a);margin-bottom:0.5rem;
      }
      .tg-ig-ka-anchor{
        font-family:'Playfair Display',serif;font-style:italic;
        font-size:1.15rem;color:#f4ede0;line-height:1.3;margin-bottom:0.45rem;
      }
      .tg-ig-ka-lenses{display:flex;flex-wrap:wrap;gap:0.4rem;}
      .tg-ig-ka-lens{
        font-family:'DM Mono',monospace;font-size:0.55rem;letter-spacing:0.16em;
        text-transform:uppercase;color:var(--gold-light,#d4aa4a);
        border:1px solid rgba(184,146,42,0.30);padding:0.3rem 0.55rem;
        background:rgba(184,146,42,0.05);
      }
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
      .tg-ig-idea-meta{
        display:flex;flex-wrap:wrap;gap:0.6rem;align-items:center;
        margin:0 0 0.6rem;
      }
      .tg-ig-idea-lens{
        font-family:'DM Mono',monospace;font-size:0.5rem;letter-spacing:0.18em;
        text-transform:uppercase;color:var(--gold-light,#d4aa4a);
        border:1px solid rgba(184,146,42,0.3);padding:0.22rem 0.5rem;
        background:rgba(184,146,42,0.06);
      }
      .tg-ig-idea-gap{
        font-family:'Cormorant Garamond',serif;font-style:italic;
        font-size:0.95rem;line-height:1.5;color:#a89c88;
        padding:0.4rem 0.7rem;margin:0 0 0.7rem;
        border-left:2px solid #c0392b;background:rgba(192,57,43,0.04);
      }
      .tg-ig-idea-gap-label{
        font-family:'DM Mono',monospace;font-size:0.5rem;letter-spacing:0.22em;
        text-transform:uppercase;color:#c0392b;margin-right:0.4rem;
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
      /* Ivy's note - her voice on the gap landscape, after the 3 ideas. */
      .tg-ig-ivy-note{
        font-family:'Playfair Display',serif;font-style:italic;
        font-size:1.05rem;line-height:1.6;color:var(--gold-light,#d4aa4a);
        padding:0.9rem 1.1rem;margin-bottom:1.2rem;
        border-left:2px solid var(--gold,#b8922a);
        background:rgba(184,146,42,0.05);
      }
      .tg-ig-ivy-note-label{
        font-family:'DM Mono',monospace;font-style:normal;
        font-size:0.5rem;letter-spacing:0.22em;text-transform:uppercase;
        color:var(--gold,#b8922a);margin-bottom:0.35rem;display:block;
      }

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
        <div class="tg-ig-mode" role="tablist" aria-label="Idea generator mode">
          <button class="tg-ig-mode-tab" data-mode="basic" role="tab" type="button">
            <div class="tg-ig-mode-tab-row">
              <span>Basic</span>
              <span class="tg-ig-mode-chip is-free">Free</span>
            </div>
            <span class="tg-ig-mode-tab-sub">Three ideas. Quick.</span>
          </button>
          <button class="tg-ig-mode-tab" data-mode="slr" role="tab" type="button">
            <div class="tg-ig-mode-tab-row">
              <span>SLR · Advanced</span>
              <span class="tg-ig-mode-chip">Paid</span>
            </div>
            <span class="tg-ig-mode-tab-sub">Ms. Ivy mines the gaps. The gaps are where new ideas live.</span>
          </button>
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

    // Mode toggle. Clicking sets state.mode and re-paints the toggle's
    // active state. The mode is only consumed when the user hits Generate
    // - switching mid-flow does NOT discard their answers.
    backdrop.querySelectorAll('.tg-ig-mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        state.mode = tab.getAttribute('data-mode') === 'slr' ? 'slr' : 'basic';
        updateModeTabs();
      });
    });
    updateModeTabs();
  }

  function updateModeTabs(){
    if (!backdrop) return;
    backdrop.querySelectorAll('.tg-ig-mode-tab').forEach(tab => {
      const isActive = tab.getAttribute('data-mode') === state.mode;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  function open(){
    injectStyles();
    buildShell();
    state.step = 0;
    state.answers = { world:'', frustration:'', bring:'' };
    state.otherTexts = { world:'', frustration:'', bring:'' };
    state.mode = 'basic';
    state.ideas = null;
    state.keyword_architecture = null;
    state.ivy_note = '';
    backdrop.classList.add('is-open');
    render();
    // No autoplay. The host bar is clickable; the user taps to hear Ivy.
    // This avoids ambushing anyone scrolling in a meeting with audio.
    setIvyStatus('Tap to hear her ▶', false);
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

  function expertiseStatusLabel(){
    if (state.expertise.pdfBase64) return 'CV attached';
    if (state.expertise.text)      return 'Summary added';
    return 'Optional';
  }

  function renderExpertisePanel(){
    const exp = state.expertise;
    const isOpen = state.expertiseOpen;
    const statusLabel = expertiseStatusLabel();
    const statusCls   = (exp.pdfBase64 || exp.text) ? 'is-loaded' : '';
    const tabPdf    = exp.text && !exp.pdfBase64 ? '' : ' is-active';
    const tabText   = exp.text && !exp.pdfBase64 ? ' is-active' : '';
    const paneText  = tabText;
    const panePdf   = tabPdf;
    const loadedCls = exp.pdfBase64 ? ' is-visible' : '';
    const sizeKB = exp.pdfSize ? Math.round(exp.pdfSize / 1024) + ' KB' : '';
    return `
      <div class="tg-ig-exp${isOpen ? ' is-open' : ''}" id="tg-ig-exp">
        <div class="tg-ig-exp-head" id="tg-ig-exp-head">
          <svg class="tg-ig-exp-head__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>
          <span class="tg-ig-exp-head__label">Tell Ivy about your expertise</span>
          <span class="tg-ig-exp-head__status ${statusCls}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="tg-ig-exp-body">
          <div class="tg-ig-exp-tabs">
            <button type="button" class="tg-ig-exp-tab${panePdf}" data-exp-tab="pdf">Upload CV (PDF)</button>
            <button type="button" class="tg-ig-exp-tab${paneText}" data-exp-tab="text">Or paste a summary</button>
          </div>
          <div class="tg-ig-exp-pane${panePdf}" data-exp-pane="pdf">
            <div class="tg-ig-exp-drop" id="tg-ig-exp-drop">
              <div>Drop a CV PDF here, or click to upload</div>
              <div class="tg-ig-exp-drop__hint">Under 3.5 MB. Ivy reads the document directly to match ideas to your actual track record.</div>
              <input type="file" id="tg-ig-exp-file" accept="application/pdf" style="display:none;">
            </div>
            <div class="tg-ig-exp-loaded${loadedCls}" id="tg-ig-exp-loaded">
              <span class="tg-ig-exp-loaded__name">${escapeHtml(exp.pdfName || '')} ${sizeKB}</span>
              <button type="button" class="tg-ig-exp-loaded__remove" id="tg-ig-exp-remove">Remove</button>
            </div>
          </div>
          <div class="tg-ig-exp-pane${paneText}" data-exp-pane="text">
            <textarea class="tg-ig-exp-text" id="tg-ig-exp-text" placeholder="Credential + a few sentences. e.g. PharmD with 10 years in oncology, currently teaching pharmacology to PA students. Published on chemo-induced nausea protocols.">${escapeHtml(exp.text || '')}</textarea>
          </div>
          <div class="tg-ig-exp-priv">Your CV or summary is sent to Anthropic's Claude API for analysis. Anthropic does not train on or retain API content. We do not log or store anything. If your CV includes home address or other PII you would rather not share, redact those lines first.</div>
        </div>
      </div>
    `;
  }

  function bindExpertise(){
    const head     = bodyEl.querySelector('#tg-ig-exp-head');
    const root     = bodyEl.querySelector('#tg-ig-exp');
    const drop     = bodyEl.querySelector('#tg-ig-exp-drop');
    const file     = bodyEl.querySelector('#tg-ig-exp-file');
    const loaded   = bodyEl.querySelector('#tg-ig-exp-loaded');
    const removeBtn= bodyEl.querySelector('#tg-ig-exp-remove');
    const text     = bodyEl.querySelector('#tg-ig-exp-text');
    const tabs     = bodyEl.querySelectorAll('.tg-ig-exp-tab');
    const panes    = bodyEl.querySelectorAll('.tg-ig-exp-pane');
    if (!head || !root) return;

    head.addEventListener('click', () => {
      state.expertiseOpen = !state.expertiseOpen;
      root.classList.toggle('is-open', state.expertiseOpen);
    });

    tabs.forEach(t => t.addEventListener('click', () => {
      const which = t.getAttribute('data-exp-tab');
      tabs.forEach(x => x.classList.toggle('is-active', x === t));
      panes.forEach(p => p.classList.toggle('is-active', p.getAttribute('data-exp-pane') === which));
    }));

    function loadPdfFile(f){
      if (!f || f.type !== 'application/pdf'){
        alert('Please upload a PDF file.');
        return;
      }
      if (f.size > PDF_MAX_BYTES){
        alert('CV over 3.5 MB. Compress and try again, or paste a short summary instead.');
        return;
      }
      const reader = new FileReader();
      reader.onload = e => {
        const dataUrl = e.target.result;
        const b64 = String(dataUrl).split(',')[1] || '';
        state.expertise.pdfBase64 = b64;
        state.expertise.pdfName   = f.name || 'cv.pdf';
        state.expertise.pdfSize   = f.size;
        // PDF beats text when both are present. Clear text to avoid the
        // backend sending both for the same generation.
        renderQuestion();
        state.expertiseOpen = true;
        const root2 = bodyEl.querySelector('#tg-ig-exp');
        if (root2) root2.classList.add('is-open');
      };
      reader.onerror = () => { alert('Could not read file.'); };
      reader.readAsDataURL(f);
    }

    if (drop && file){
      drop.addEventListener('click', () => file.click());
      file.addEventListener('change', e => { if (e.target.files && e.target.files[0]) loadPdfFile(e.target.files[0]); });
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--gold, #b8922a)'; });
      drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
      drop.addEventListener('drop', e => {
        e.preventDefault(); drop.style.borderColor = '';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) loadPdfFile(e.dataTransfer.files[0]);
      });
    }
    if (removeBtn){
      removeBtn.addEventListener('click', () => {
        state.expertise.pdfBase64 = null;
        state.expertise.pdfName   = '';
        state.expertise.pdfSize   = 0;
        if (file) file.value = '';
        renderQuestion();
        const root2 = bodyEl.querySelector('#tg-ig-exp');
        if (root2) root2.classList.add('is-open');
        state.expertiseOpen = true;
      });
    }
    if (text){
      text.addEventListener('input', e => {
        state.expertise.text = String(e.target.value || '').slice(0, EXPERTISE_TEXT_CAP);
      });
    }
  }

  function renderQuestion(){
    const q = QUESTIONS[state.step];
    const current = state.answers[q.key];

    let html = `
      ${renderExpertisePanel()}
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
    bindExpertise();
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
      mode:        state.mode,
      world:       finalAnswer(Q1),
      frustration: finalAnswer(Q2),
      bring:       finalAnswer(Q3),
    };
    // Optional expertise context. PDF beats text when both present; backend
    // ignores text in that case anyway, but we only send one to keep the
    // request small.
    if (state.expertise.pdfBase64){
      payload.expertise_pdf = { type: 'application/pdf', data: state.expertise.pdfBase64 };
    } else if (state.expertise.text){
      payload.expertise_text = state.expertise.text;
    }

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
      state.keyword_architecture = data.keyword_architecture || null;
      state.ivy_note = data.ivy_note || '';
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
    const isSlr = state.mode === 'slr' && state.keyword_architecture && state.keyword_architecture.anchor;

    const cards = ideas.map((it, i) => `
      <div class="tg-ig-idea">
        <div class="tg-ig-idea-title">${escapeHtml(it.title)}</div>
        ${isSlr && it.lens ? `<div class="tg-ig-idea-meta"><span class="tg-ig-idea-lens">Lens · ${escapeHtml(it.lens)}</span></div>` : ''}
        <p class="tg-ig-idea-desc">${escapeHtml(it.description)}</p>
        ${isSlr && it.gap ? `<p class="tg-ig-idea-gap"><span class="tg-ig-idea-gap-label">Where the gap is</span>${escapeHtml(it.gap)}</p>` : ''}
        <button class="tg-ig-idea-cta" type="button" data-pick-idea="${i}">Take it through The Gauntlet →</button>
      </div>
    `).join('');

    let kaBlock = '';
    let ivyNoteBlock = '';
    let eyebrow = 'Ivy found three';
    let title   = 'Pick one. <em>Or send me back for three more.</em>';
    let sub     = 'Take one of these ideas through The Gauntlet to polish it, then to the Chamber to be judged...';

    if (isSlr){
      const ka = state.keyword_architecture;
      kaBlock = `
        <div class="tg-ig-ka">
          <div class="tg-ig-ka-label">SLR · Keyword architecture</div>
          <div class="tg-ig-ka-anchor">Anchor: ${escapeHtml(ka.anchor)}</div>
          ${ka.secondary_anchors && ka.secondary_anchors.length ? `
            <div class="tg-ig-ka-lenses">
              ${ka.secondary_anchors.map(l => `<span class="tg-ig-ka-lens">${escapeHtml(l)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      `;
      if (state.ivy_note){
        ivyNoteBlock = `
          <div class="tg-ig-ivy-note">
            <span class="tg-ig-ivy-note-label">Where the gaps cluster · Ivy's read</span>
            ${escapeHtml(state.ivy_note)}
          </div>
        `;
      }
      eyebrow = 'Ms. Ivy mined the gaps';
      title   = 'Three gaps. <em>Pick one to fill.</em>';
      sub     = 'Ms. Ivy mines the gaps. The gaps are where new ideas live. Each card below sits in a place where nothing is currently being done. Take one through The Gauntlet to polish it, then to the Chamber to be judged...';
    }

    bodyEl.innerHTML = `
      <div class="tg-ig-eyebrow">${escapeHtml(eyebrow)}</div>
      <h2 class="tg-ig-title">${title}</h2>
      <p class="tg-ig-sub">${sub}</p>
      ${kaBlock}
      ${ivyNoteBlock}
      <div class="tg-ig-idea-list">${cards}</div>
    `;
    navEl.innerHTML = `
      <button class="tg-ig-btn" id="tg-ig-regen">Show me 3 more</button>
      <button class="tg-ig-btn" id="tg-ig-close-result">Close</button>
    `;

    // Picking a candidate seeds the SAME brief key the pasted-idea path
    // uses (tg_visitor_brief), then walks the client down the corridor
    // where the EPs give personalized feedback on this specific idea.
    // The corridor's own "Enter the Chamber" CTA carries them to the
    // judges when they are ready. We also keep the intake prefill keys so
    // the Chamber intake pre-populates once they get there.
    //
    // CRITICAL: we ALSO fire a silent intake submission so the idea is
    // registered with the Gauntlet pipeline (gets a submission_id and a
    // requirement vector) BEFORE the visitor reaches the Chamber. Without
    // this, the Chamber has no submission to evaluate and falls to demo
    // mode, even though the visitor genuinely brought an idea via Ivy.
    bodyEl.querySelectorAll('[data-pick-idea]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-pick-idea'), 10);
        const chosen = ideas[i];
        if (!chosen) return;
        const brief = (String(chosen.title || '') + '\n\n' + String(chosen.description || '')).trim();
        try {
          sessionStorage.setItem('tg_visitor_brief',       brief);
          sessionStorage.setItem('tg_prefill_title',       chosen.title);
          sessionStorage.setItem('tg_prefill_description', chosen.description);
        } catch(_){}

        // Fire silent intake submission. We do not await this; the corridor
        // and EP work proceeds immediately. The submission ID lands in
        // sessionStorage when the backend responds, so by the time the
        // visitor reaches /chamber.html (after walking the EPs), the real
        // submission is ready and the chamber runs evaluation mode instead
        // of demo mode.
        autoSubmitIdea(chosen);

        close();
        // Re-fetch the corridor briefings against the new brief so each EP
        // wing reacts to this idea, then scroll the client into the corridor.
        if (window.TGCorridor && typeof window.TGCorridor.refresh === 'function') {
          window.TGCorridor.refresh();
        }
        const corridor = document.getElementById('corridor-wings');
        if (corridor && typeof corridor.scrollIntoView === 'function') {
          corridor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          window.location.href = '/#corridor-wings';
        }
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
