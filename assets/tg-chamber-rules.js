/* ─────────────────────────────────────────────────────────────────────────────
   tg-chamber-rules.js — the rules of The Chamber, the profanity filter, and
   the ejection screen.

   Pattern ported from SLR Studio's Cleo profanity filter (app.html:20583)
   with the same word list as a starting point. Edit the PROFANITY array in
   one place to update both surfaces.

   Three jobs in one file:

     1. THE RULES MODAL
        Fires on chamber.html load if the visitor has not yet acknowledged
        the rules this session. Required checkbox + disabled-until-checked
        "Enter The Chamber" button. SessionStorage flag once acknowledged
        so the modal does not re-fire on the same tab.

     2. THE PROFANITY FILTER
        Exposed as TGChamberRules.check(text). Word-boundary regex against
        a lowercase pass of the input. Same pattern as Cleo. Caller decides
        what to do with a positive hit.

     3. THE EJECTION SCREEN
        Exposed as TGChamberRules.eject(). A full-page theatrical takeover:
        "You have been removed from The Chamber." with a link home. Used by
        both intake.html (refused submit) and chamber.html (caught on load).

   Public API:
     TGChamberRules.check(text)          - true if profanity detected
     TGChamberRules.eject(opts)          - take over the page with ejection
     TGChamberRules.openRules()          - manually open the rules modal
     TGChamberRules.isAcknowledged()     - has the visitor acked this session
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  // ── Word list. Ported from SLR Studio Cleo (app.html:20583) and
  // expanded with common derivations - the bare word "fuck" with a strict
  // \bfuck\b regex misses "fucking", "fucked", "fucker". Each derivation
  // is listed explicitly so word boundaries still keep us out of innocent
  // words like "Massachusetts" or "assignment".
  const PROFANITY = [
    // profanity + derivations
    'fuck', 'fucks', 'fucked', 'fucking', 'fucker', 'fuckers', 'fuckin',
    'shit', 'shits', 'shitty', 'bullshit',
    'bitch', 'bitches', 'bitching', 'bitchy',
    'cunt', 'cunts',
    'bastard', 'bastards',
    'piss', 'pissed', 'pissing',
    'cock', 'cocks',
    'dick', 'dicks', 'dickhead',
    'asshole', 'assholes',
    'ass', 'asses',
    // slurs + derivations
    'faggot', 'faggots', 'fag', 'fags',
    'nigger', 'niggers', 'nigga', 'niggas',
    'retard', 'retards', 'retarded',
    'tranny', 'trannies',
  ];

  const KEY_ACK = 'tg_chamber_rules_acknowledged';

  // ── sessionStorage helpers (private-browsing safe) ──────────────────────
  function ssGet(k){ try { return sessionStorage.getItem(k); } catch(_) { return null; } }
  function ssSet(k, v){ try { sessionStorage.setItem(k, v); } catch(_) {} }

  // ── Profanity check ─────────────────────────────────────────────────────
  function check(text) {
    if (!text) return false;
    const lower = String(text).toLowerCase();
    for (let i = 0; i < PROFANITY.length; i++) {
      const re = new RegExp('\\b' + PROFANITY[i] + '\\b');
      if (re.test(lower)) return true;
    }
    return false;
  }

  // ── Styles ──────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('tg-chamber-rules-styles')) return;
    const css = `
      .tg-rules-backdrop, .tg-eject-backdrop {
        position: fixed; inset: 0; z-index: 9500;
        background: rgba(8,6,4,0.88);
        backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        padding: 1.5rem;
        opacity: 0; pointer-events: none;
        transition: opacity 0.34s ease;
      }
      .tg-rules-backdrop.is-open, .tg-eject-backdrop.is-open {
        opacity: 1; pointer-events: auto;
      }

      .tg-rules-modal, .tg-eject-modal {
        position: relative;
        width: 100%; max-width: 620px; max-height: 92vh; overflow-y: auto;
        background: var(--bg, #0a0807);
        border: 1px solid rgba(212,170,74,0.4);
        box-shadow:
          0 0 0 1px rgba(212,170,74,0.08),
          0 24px 60px -12px rgba(0,0,0,0.7),
          0 0 80px -20px rgba(212,170,74,0.2);
        padding: 2.2rem 2rem 1.8rem;
        color: var(--text, #e6dccd);
        transform: translateY(14px);
        transition: transform 0.42s ease;
      }
      .tg-rules-backdrop.is-open .tg-rules-modal,
      .tg-eject-backdrop.is-open .tg-eject-modal { transform: translateY(0); }

      .tg-rules-eyebrow, .tg-eject-eyebrow {
        font-family: 'DM Mono', monospace; font-size: 0.62rem; letter-spacing: 0.32em;
        text-transform: uppercase; color: var(--gold, #b8922a);
        margin-bottom: 0.7rem;
      }
      .tg-rules-title, .tg-eject-title {
        font-family: 'Playfair Display', serif; font-size: 1.8rem; line-height: 1.15;
        font-weight: 700; color: var(--cream, #f4ecd8);
        margin: 0 0 1.2rem; letter-spacing: -0.01em;
      }
      .tg-eject-title { color: var(--gauntlet-consequence, #c0392b); }

      .tg-rules-intro {
        font-family: 'Cormorant Garamond', serif; font-size: 1.05rem; line-height: 1.55;
        color: var(--text, #e6dccd); font-style: italic;
        margin: 0 0 1.6rem;
      }

      .tg-rule {
        border-top: 1px solid rgba(212,170,74,0.2);
        padding: 1.1rem 0;
      }
      .tg-rule:last-of-type { border-bottom: 1px solid rgba(212,170,74,0.2); }
      .tg-rule-head {
        font-family: 'DM Mono', monospace; font-size: 0.7rem; letter-spacing: 0.18em;
        text-transform: uppercase; color: var(--gold, #b8922a);
        margin-bottom: 0.5rem;
      }
      .tg-rule-body {
        font-family: 'Cormorant Garamond', serif; font-size: 1rem; line-height: 1.6;
        color: var(--text, #e6dccd); margin: 0;
      }
      .tg-rule-body ul { margin: 0.5rem 0 0; padding-left: 1.2rem; }
      .tg-rule-body li { margin-bottom: 0.4rem; }

      .tg-rules-ack {
        display: flex; align-items: flex-start; gap: 0.7rem;
        margin: 1.4rem 0 1rem;
        padding: 0.9rem 0.95rem;
        background: rgba(212,170,74,0.05);
        border: 1px solid rgba(212,170,74,0.2);
        cursor: pointer;
      }
      .tg-rules-ack input {
        margin-top: 0.25rem;
        accent-color: var(--gold, #b8922a);
        width: 16px; height: 16px;
        flex-shrink: 0;
      }
      .tg-rules-ack-text {
        font-family: 'Cormorant Garamond', serif; font-size: 1.02rem; line-height: 1.4;
        color: var(--cream, #f4ecd8);
      }

      .tg-rules-go, .tg-eject-go {
        font-family: 'DM Mono', monospace; font-size: 0.78rem; letter-spacing: 0.14em;
        text-transform: uppercase;
        padding: 0.85rem 1.5rem; cursor: pointer;
        background: var(--gold, #b8922a); color: #1a130a;
        border: 1px solid var(--gold, #b8922a);
        transition: all 0.18s;
        width: 100%;
      }
      .tg-rules-go:hover:not(:disabled), .tg-eject-go:hover {
        background: var(--gold-light, #d4aa4a);
        border-color: var(--gold-light, #d4aa4a);
      }
      .tg-rules-go:disabled {
        opacity: 0.35; cursor: not-allowed;
      }

      .tg-eject-body {
        font-family: 'Cormorant Garamond', serif; font-size: 1.08rem; line-height: 1.55;
        color: var(--text, #e6dccd); margin: 0 0 1.4rem;
      }
      .tg-eject-body strong { color: var(--cream, #f4ecd8); }

      @media (max-width: 520px) {
        .tg-rules-modal, .tg-eject-modal { padding: 1.6rem 1.2rem 1.4rem; }
        .tg-rules-title, .tg-eject-title { font-size: 1.5rem; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'tg-chamber-rules-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Rules modal ────────────────────────────────────────────────────────
  function showRules(opts) {
    injectStyles();
    const onAck = (opts && opts.onAck) || function(){};

    const backdrop = document.createElement('div');
    backdrop.className = 'tg-rules-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'tg-rules-title');
    backdrop.innerHTML = `
      <div class="tg-rules-modal">
        <div class="tg-rules-eyebrow">The Chamber</div>
        <h2 class="tg-rules-title" id="tg-rules-title">The rules.</h2>
        <p class="tg-rules-intro">Three things before you watch the panel.</p>

        <div class="tg-rule">
          <div class="tg-rule-head">1. The judges judge. The audience does not.</div>
          <p class="tg-rule-body">
            Three judges score the active dimension using a fixed math, not opinion. The other six watch from the audience. They chime in, react, heckle. That side commentary is part of the entertainment. It does not affect your score.
          </p>
        </div>

        <div class="tg-rule">
          <div class="tg-rule-head">2. The audience is part of the production.</div>
          <p class="tg-rule-body">
            What they say is theater. It may sting. The verdict is the math, not the heckles.
          </p>
        </div>

        <div class="tg-rule">
          <div class="tg-rule-head">3. Conduct.</div>
          <div class="tg-rule-body">
            <ul>
              <li>Your idea stays yours. We do not train AI on it, do not sell it, do not share it.</li>
              <li>Profanity, slurs, or attacks on the judges or other users will get you removed from The Chamber. Disagreement is welcome. Abuse is not.</li>
              <li>One submission gets one verdict. You can revise and resubmit. You cannot reroll the same brief to chase a higher score.</li>
            </ul>
          </div>
        </div>

        <label class="tg-rules-ack" for="tg-rules-checkbox">
          <input type="checkbox" id="tg-rules-checkbox">
          <span class="tg-rules-ack-text">I have read the rules of The Chamber.</span>
        </label>

        <button class="tg-rules-go" type="button" id="tg-rules-enter" disabled>Enter The Chamber &rarr;</button>
      </div>
    `;
    document.body.appendChild(backdrop);

    const checkbox = backdrop.querySelector('#tg-rules-checkbox');
    const enterBtn = backdrop.querySelector('#tg-rules-enter');

    checkbox.addEventListener('change', () => {
      enterBtn.disabled = !checkbox.checked;
    });

    enterBtn.addEventListener('click', () => {
      if (!checkbox.checked) return;
      ssSet(KEY_ACK, '1');
      backdrop.classList.remove('is-open');
      setTimeout(() => {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      }, 420);
      try { onAck(); } catch(_) {}
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => backdrop.classList.add('is-open'));
    });
  }

  // ── Ejection screen ────────────────────────────────────────────────────
  function eject(opts) {
    injectStyles();
    const reason = (opts && opts.reason) || 'Your submission contained language that violates The Chamber\'s conduct rules.';

    // Wipe any other open modals/backdrops so the ejection is unambiguous.
    document.querySelectorAll('.tg-rules-backdrop, .tg-welcome-backdrop').forEach(n => n.remove());

    const backdrop = document.createElement('div');
    backdrop.className = 'tg-eject-backdrop';
    backdrop.setAttribute('role', 'alertdialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = `
      <div class="tg-eject-modal">
        <div class="tg-eject-eyebrow">The Chamber</div>
        <h2 class="tg-eject-title">Removed from The Chamber.</h2>
        <p class="tg-eject-body">
          ${reason} <strong>The evaluation has been stopped.</strong> Read the rules and revise your submission before trying again.
        </p>
        <button class="tg-eject-go" type="button" id="tg-eject-home">Return Home &rarr;</button>
      </div>
    `;
    document.body.appendChild(backdrop);

    backdrop.querySelector('#tg-eject-home').addEventListener('click', () => {
      window.location.href = '/';
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => backdrop.classList.add('is-open'));
    });
  }

  function isAcknowledged() { return ssGet(KEY_ACK) === '1'; }

  // Public API.
  window.TGChamberRules = {
    check:          check,
    eject:          eject,
    openRules:      showRules,
    isAcknowledged: isAcknowledged,
  };

  // Auto-fire the rules modal on chamber.html if the visitor has not yet
  // acknowledged this session. Detection is by URL so the script can be
  // loaded site-wide without modal pollution.
  function autoInit() {
    const onChamber = /\/chamber\.html(?:$|[?#])/.test(location.pathname + location.search);
    if (!onChamber) return;
    if (isAcknowledged()) return;
    // Small delay so the chamber paints before the rules modal overlays it.
    setTimeout(showRules, 450);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})();
