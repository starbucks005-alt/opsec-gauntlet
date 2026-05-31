/* ─────────────────────────────────────────────────────────────────────────────
   tg-welcome.js — first-visit welcome gate.

   Fires once per session on pages that include this script. Asks the visitor
   for two optional things:

     - name:  so the EPs and judges can address them by it
     - brief: so the EP briefings and the judges' analysis are about THEIR
              idea, not generic templates

   Includes a plain-English "Why we ask" disclosure and the data contract:
   session-only by default; persists only if the visitor creates an account.

   Behavior:
     - Fires after a short delay on DOMContentLoaded if `tg_welcome_dismissed`
       is not set in sessionStorage.
     - Either button (Skip or Personalize) sets the dismissed flag so the
       modal does NOT re-fire on this session.
     - Personalize saves whatever the visitor typed into:
         sessionStorage.tg_visitor_name
         sessionStorage.tg_visitor_brief
       Either field can be blank; the visitor controls what they share.
     - Skip stores nothing - the visitor moves through The Gauntlet as a
       guest, sees the generic experience.
     - Backdrop click and Escape key also dismiss (same as Skip).

   This file is intentionally self-contained (own CSS, own DOM, no
   external dependencies) so adding it to a page is one script tag.

   sessionStorage keys (read by downstream slices B.2 / B.3):
     tg_visitor_name        - visitor's first name (string, may be empty)
     tg_visitor_brief       - their pasted brief (string, may be empty)
     tg_welcome_dismissed   - "1" once they have seen and acted on the modal
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const KEY_NAME      = 'tg_visitor_name';
  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_DISMISSED = 'tg_welcome_dismissed';
  const SHOW_DELAY_MS = 450;   // small breath so the page paints first
  const NAME_MAX      = 60;
  const BRIEF_MAX     = 3000;

  // ── sessionStorage helpers (private-browsing safe) ──────────────────────
  function ssGet(key){
    try { return sessionStorage.getItem(key); }
    catch(_) { return null; }
  }
  function ssSet(key, val){
    try { sessionStorage.setItem(key, val); }
    catch(_) { /* ignore - private mode or quota; modal just won't suppress */ }
  }

  // ── Styles. Match the site palette: dark base, gold accents, cream text.
  // CSS variables come from the host page's root scope; we fall back to
  // literal values so the modal still looks right if it ever loads on a
  // page that has not defined the design tokens.
  function injectStyles(){
    if (document.getElementById('tg-welcome-styles')) return;
    const css = `
      .tg-welcome-backdrop{
        position:fixed;inset:0;z-index:9000;
        background:rgba(8,6,4,0.78);
        backdrop-filter:blur(4px);
        display:flex;align-items:center;justify-content:center;
        padding:1.5rem;
        opacity:0;pointer-events:none;
        transition:opacity 0.32s ease;
      }
      .tg-welcome-backdrop.is-open{opacity:1;pointer-events:auto;}

      .tg-welcome-modal{
        position:relative;
        width:100%;max-width:580px;max-height:92vh;overflow-y:auto;
        background:var(--bg, #0a0807);
        border:1px solid rgba(212,170,74,0.35);
        box-shadow:
          0 0 0 1px rgba(212,170,74,0.08),
          0 24px 60px -12px rgba(0,0,0,0.7),
          0 0 80px -20px rgba(212,170,74,0.18);
        padding:2.2rem 2rem 1.8rem;
        color:var(--text, #e6dccd);
        transform:translateY(12px);
        transition:transform 0.4s ease;
      }
      .tg-welcome-backdrop.is-open .tg-welcome-modal{transform:translateY(0);}

      .tg-welcome-close{
        position:absolute;top:0.7rem;right:0.9rem;
        background:transparent;border:none;color:var(--gold, #b8922a);
        font-size:1.5rem;line-height:1;cursor:pointer;
        padding:0.25rem 0.5rem;opacity:0.7;
      }
      .tg-welcome-close:hover{opacity:1;color:var(--gold-light, #d4aa4a);}

      .tg-welcome-eyebrow{
        font-family:'DM Mono',monospace;font-size:0.62rem;letter-spacing:0.32em;
        text-transform:uppercase;color:var(--gold, #b8922a);
        margin-bottom:0.7rem;
      }
      .tg-welcome-title{
        font-family:'Playfair Display',serif;font-size:1.7rem;line-height:1.15;
        font-weight:700;color:var(--cream, #f4ecd8);margin:0 0 0.5rem;
        letter-spacing:-0.01em;
      }
      .tg-welcome-sub{
        font-family:'Cormorant Garamond',serif;font-size:1.05rem;line-height:1.5;
        color:var(--text, #e6dccd);margin:0 0 1.6rem;
      }

      .tg-welcome-label{
        display:block;
        font-family:'DM Mono',monospace;font-size:0.68rem;letter-spacing:0.18em;
        text-transform:uppercase;color:var(--cream, #f4ecd8);
        margin:0 0 0.45rem;
      }
      .tg-welcome-input,
      .tg-welcome-textarea{
        width:100%;box-sizing:border-box;
        background:rgba(0,0,0,0.4);
        border:1px solid rgba(212,170,74,0.25);
        color:var(--cream, #f4ecd8);
        font-family:'Cormorant Garamond',serif;font-size:1.05rem;line-height:1.5;
        padding:0.7rem 0.85rem;
        margin-bottom:1.2rem;
        outline:none;
        transition:border-color 0.18s;
      }
      .tg-welcome-input:focus,
      .tg-welcome-textarea:focus{border-color:var(--gold-light, #d4aa4a);}
      .tg-welcome-textarea{resize:vertical;min-height:120px;}

      .tg-welcome-why{
        border-top:1px solid rgba(212,170,74,0.18);
        padding-top:1.1rem;margin-top:0.4rem;margin-bottom:1.4rem;
      }
      .tg-welcome-why-head{
        font-family:'DM Mono',monospace;font-size:0.66rem;letter-spacing:0.2em;
        text-transform:uppercase;color:var(--gold, #b8922a);
        margin-bottom:0.5rem;
      }
      .tg-welcome-why p{
        font-family:'Cormorant Garamond',serif;font-size:0.98rem;line-height:1.55;
        color:var(--text, #e6dccd);margin:0 0 0.6rem;
      }
      .tg-welcome-why p:last-child{margin-bottom:0;}

      .tg-welcome-actions{
        display:flex;gap:0.8rem;flex-wrap:wrap;
        justify-content:flex-end;align-items:center;
        margin-bottom:1rem;
      }
      .tg-welcome-btn{
        font-family:'DM Mono',monospace;font-size:0.72rem;letter-spacing:0.14em;
        text-transform:uppercase;
        padding:0.7rem 1.2rem;cursor:pointer;
        border:1px solid var(--gold, #b8922a);
        background:transparent;color:var(--gold-light, #d4aa4a);
        transition:all 0.18s;
      }
      .tg-welcome-btn:hover{background:rgba(212,170,74,0.08);color:var(--cream, #f4ecd8);}
      .tg-welcome-btn-go{
        background:var(--gold, #b8922a);color:#1a130a;border-color:var(--gold, #b8922a);
      }
      .tg-welcome-btn-go:hover{
        background:var(--gold-light, #d4aa4a);color:#1a130a;
      }

      .tg-welcome-about{
        display:inline-block;
        font-family:'DM Mono',monospace;font-size:0.66rem;letter-spacing:0.14em;
        text-transform:uppercase;
        color:var(--gold, #b8922a);text-decoration:none;
        border-bottom:1px solid rgba(212,170,74,0.4);
        padding-bottom:0.15rem;
      }
      .tg-welcome-about:hover{color:var(--gold-light, #d4aa4a);border-color:var(--gold-light, #d4aa4a);}

      @media (max-width:520px){
        .tg-welcome-modal{padding:1.6rem 1.2rem 1.4rem;}
        .tg-welcome-title{font-size:1.45rem;}
        .tg-welcome-actions{justify-content:stretch;}
        .tg-welcome-btn{flex:1;text-align:center;}
      }
    `;
    const style = document.createElement('style');
    style.id = 'tg-welcome-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── DOM ────────────────────────────────────────────────────────────────
  function buildShell(){
    const backdrop = document.createElement('div');
    backdrop.className = 'tg-welcome-backdrop';
    backdrop.id = 'tg-welcome-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'tg-welcome-title');
    backdrop.innerHTML = `
      <div class="tg-welcome-modal">
        <button class="tg-welcome-close" type="button" aria-label="Close">&times;</button>

        <div class="tg-welcome-eyebrow">Welcome to The Gauntlet</div>
        <h2 class="tg-welcome-title" id="tg-welcome-title">Two quick questions before you start.</h2>
        <p class="tg-welcome-sub">Both optional. They make the experience personal. Without them you get the generic version.</p>

        <label class="tg-welcome-label" for="tg-welcome-name">What should we call you?</label>
        <input class="tg-welcome-input" id="tg-welcome-name" type="text"
               placeholder="(your first name)" maxlength="${NAME_MAX}"
               autocomplete="given-name" spellcheck="false">

        <label class="tg-welcome-label" for="tg-welcome-brief">Have an idea already? Paste it here.</label>
        <textarea class="tg-welcome-textarea" id="tg-welcome-brief"
                  placeholder="A sentence or a few paragraphs. Your call."
                  maxlength="${BRIEF_MAX}" rows="5"></textarea>

        <div class="tg-welcome-why">
          <div class="tg-welcome-why-head">Why we ask</div>
          <p>Your name lets our specialists and judges address you directly. Your brief lets them respond to your idea specifically, not in templates. We do not train AI on what you share. We do not sell it. We do not share it.</p>
          <p>When you close this tab, we forget you. If you want to keep your runs and come back, you can make an account at any time.</p>
        </div>

        <div class="tg-welcome-actions">
          <button class="tg-welcome-btn" type="button" data-tg-welcome-skip>Skip — start as a guest</button>
          <button class="tg-welcome-btn tg-welcome-btn-go" type="button" data-tg-welcome-go>Personalize</button>
        </div>

        <a class="tg-welcome-about" href="/about.html">About Dr. Terry Oroszi, who runs this &rarr;</a>
      </div>
    `;

    document.body.appendChild(backdrop);

    // ── Handlers ──
    const closeBtn = backdrop.querySelector('.tg-welcome-close');
    const skipBtn  = backdrop.querySelector('[data-tg-welcome-skip]');
    const goBtn    = backdrop.querySelector('[data-tg-welcome-go]');
    const nameEl   = backdrop.querySelector('#tg-welcome-name');
    const briefEl  = backdrop.querySelector('#tg-welcome-brief');

    // Pre-fill from session so users who reopen the modal (via the footer
    // or corridor "Personalize" link) see their current values and can
    // edit them, rather than starting from blank.
    const existingName  = ssGet(KEY_NAME);
    const existingBrief = ssGet(KEY_BRIEF);
    if (existingName)  nameEl.value  = existingName;
    if (existingBrief) briefEl.value = existingBrief;

    function dismiss(){
      ssSet(KEY_DISMISSED, '1');
      backdrop.classList.remove('is-open');
      // Remove from DOM after the close transition so the page is clean.
      setTimeout(() => { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }, 400);
      document.removeEventListener('keydown', onKey);
    }
    // Anonymous user id, scoped to this browser. Mirrors the helper in
    // intake.html so the same browser keeps the same id whether the
    // visitor takes the full intake or the Personalize shortcut.
    function getOrCreateAnonId(){
      var LS_KEY = 'tg_anon_user_id';
      var id = '';
      try { id = localStorage.getItem(LS_KEY) || ''; } catch(_){}
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)){
        id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
              var r = Math.random()*16|0, v = c==='x' ? r : (r&0x3|0x8);
              return v.toString(16);
            });
        try { localStorage.setItem(LS_KEY, id); } catch(_){}
      }
      return id;
    }

    // Title from the brief's first sentence (or first ~9 words). The
    // Personalize modal does not have a title field; intake-submit
    // requires one for the recommendation engine. Keeps it under the
    // backend's max title length.
    function deriveTitleFromBrief(brief){
      if (!brief) return 'Personalize brief';
      var firstSentence = brief.split(/[.!?]/)[0] || brief;
      var words = firstSentence.trim().split(/\s+/).slice(0, 9).join(' ');
      return words.slice(0, 120) || 'Personalize brief';
    }

    function personalize(){
      const name  = (nameEl.value  || '').trim().slice(0, NAME_MAX);
      const brief = (briefEl.value || '').trim().slice(0, BRIEF_MAX);
      // Always overwrite (including with empty string) so reopen-and-clear
      // is honored. The user is in control of their own session data.
      ssSet(KEY_NAME,  name);
      ssSet(KEY_BRIEF, brief);
      dismiss();
      // If the visitor pasted a real brief, POST it to the same intake
      // endpoint /intake.html uses. Without this, the Chamber later
      // arrives with no submission ID and falls to demo mode (silent
      // input, hardcoded judge lines). Fire-and-forget — corridor refresh
      // and scroll happen immediately so the modal feels responsive; the
      // POST resolves in the background and writes the submission id to
      // sessionStorage where chamber.html reads it on load.
      if (brief && brief.length >= 8) {
        var title = deriveTitleFromBrief(brief);
        fetch('/.netlify/functions/tg-intake-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: getOrCreateAnonId(),
            title: title,
            description: brief,
          }),
        })
        .then(function(resp){ return resp.json().catch(function(){ return {}; }).then(function(data){
          if (resp.ok && data && data.id) {
            try {
              sessionStorage.setItem('tg_submission_id',    data.id);
              sessionStorage.setItem('tg_submission_title', title);
              if (data.requirement_vector){
                sessionStorage.setItem('tg_submission_vector', JSON.stringify(data.requirement_vector));
              }
            } catch(_){}
            // Once the submission lands, re-trigger the corridor refresh
            // so the recommendation switches from default to cosine-sim
            // based on the actual requirement vector.
            try { if (window.TGCorridor && typeof window.TGCorridor.refresh === 'function') window.TGCorridor.refresh(); }
            catch(_){}
          } else {
            console.warn('[tg-welcome] intake-submit failed', resp.status, data && data.error);
          }
        }); })
        .catch(function(err){ console.warn('[tg-welcome] intake-submit network error', err); });
      }
      // Two things happen the moment they hit Personalize:
      //   1. Trigger the corridor refetch so "Reading your idea..." shows
      //      on each wing-card immediately.
      //   2. Smoothly scroll to the corridor so the visitor sees that
      //      loading state instead of looking at an unchanged hero for
      //      five seconds wondering if anything happened.
      try { if (window.TGCorridor && typeof window.TGCorridor.refresh === 'function') window.TGCorridor.refresh(); }
      catch(_) { /* ignore */ }
      // Defer the scroll until after the modal close transition starts so
      // the two motions read as one continuous gesture.
      setTimeout(() => {
        const corridor = document.getElementById('corridor-wings');
        if (corridor && typeof corridor.scrollIntoView === 'function') {
          corridor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 220);
    }
    function onKey(e){
      if (e.key === 'Escape') dismiss();
    }

    closeBtn.addEventListener('click', dismiss);
    skipBtn.addEventListener('click',  dismiss);
    goBtn.addEventListener('click',    personalize);
    backdrop.addEventListener('click', (e) => {
      // Click on the backdrop itself (not inside the modal) = dismiss.
      if (e.target === backdrop) dismiss();
    });
    document.addEventListener('keydown', onKey);

    return backdrop;
  }

  function show(){
    injectStyles();
    const backdrop = buildShell();
    // Two RAFs: one to ensure the element is in the layout tree, one to let
    // the transition apply. Without this the modal pops in without animating.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => backdrop.classList.add('is-open'));
    });
    // Focus the name field for keyboard users; small delay so the focus
    // ring lands after the transition starts (less jumpy).
    setTimeout(() => {
      const nameEl = backdrop.querySelector('#tg-welcome-name');
      if (nameEl) nameEl.focus();
    }, 380);
  }

  function init(){
    if (ssGet(KEY_DISMISSED)) return;
    setTimeout(show, SHOW_DELAY_MS);
  }

  // Public escape hatch in case we want to manually re-open from elsewhere
  // (e.g. a "personalize this for me" link in the footer).
  window.TGWelcome = {
    open: function(){
      // Manual open ignores the dismissed flag.
      injectStyles();
      const backdrop = buildShell();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => backdrop.classList.add('is-open'));
      });
    },
    getName:  function(){ return ssGet(KEY_NAME)  || ''; },
    getBrief: function(){ return ssGet(KEY_BRIEF) || ''; },
  };

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
