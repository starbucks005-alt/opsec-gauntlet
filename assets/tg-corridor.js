/* ─────────────────────────────────────────────────────────────────────────────
   tg-corridor.js — tailored EP briefings, applied to the corridor cards.

   On page load, if the visitor has a brief in sessionStorage (saved by the
   welcome modal, by Card 2's pitch modal, or by the Ivy idea generator),
   we POST it to /.netlify/functions/tg-ep-briefings and replace each
   .wing-quote with the tailored line for that EP. Otherwise the cards
   keep their static voice-sample quotes.

   The EP id for each card is read from the existing data-character
   attribute on the voice button inside that card. No HTML changes
   needed; this script is purely additive.

   Results are cached in sessionStorage keyed by a hash of the brief so
   page reloads do not burn extra Claude calls. The cache invalidates
   automatically when the brief changes.

   Public API:
     window.TGCorridor.refresh()  - re-fetch briefings (call this after
                                    a downstream slice updates the brief)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const ENDPOINT      = '/.netlify/functions/tg-ep-briefings';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_BRIEF     = 'tg_visitor_brief';
  // Cache keys carry a schema version. Bumping the v-suffix invalidates
  // every stale cache when the briefings response shape changes (e.g.
  // string -> { line, invitation }).
  const KEY_CACHE     = 'tg_corridor_briefings_cache_v2';
  const KEY_CACHE_SIG = 'tg_corridor_briefings_sig_v2';
  const MIN_BRIEF_LEN = 12;

  // ── sessionStorage helpers (private-browsing safe) ──────────────────────
  function ss(key)              { try { return sessionStorage.getItem(key); }      catch(_) { return null; } }
  function ssSet(key, val)      { try { sessionStorage.setItem(key, val); }        catch(_) { /* ignore */ } }
  function ssDel(key)           { try { sessionStorage.removeItem(key); }          catch(_) { /* ignore */ } }

  // Lightweight signature so we can detect when the brief changes and
  // invalidate the cached briefings. Not crypto - just a stable fingerprint.
  function sig(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return s.length + ':' + h;
  }

  // ── DOM ────────────────────────────────────────────────────────────────
  function collectCards() {
    const cards = [];
    document.querySelectorAll('.corridor-wing').forEach(card => {
      const button  = card.querySelector('[data-tg-voice][data-character]');
      const quoteEl = card.querySelector('.wing-quote');
      // The wing-link is the existing "Step into her office" anchor. When
      // a brief is loaded we replace its text with the EP's personalized
      // invitation. Original text is captured so we can fall back cleanly.
      const linkEl  = card.querySelector('.wing-link');
      if (!button || !quoteEl) return;
      cards.push({
        epId:    button.dataset.character,
        quoteEl: quoteEl,
        linkEl:  linkEl,
        linkOriginal: linkEl ? linkEl.textContent : '',
      });
    });
    return cards;
  }

  function injectStyles() {
    if (document.getElementById('tg-corridor-styles')) return;
    const css = `
      .wing-quote.tg-quote-loading {
        opacity: 0.55;
        animation: tg-quote-shimmer 1.6s ease-in-out infinite;
      }
      @keyframes tg-quote-shimmer {
        0%, 100% { opacity: 0.50; }
        50%      { opacity: 0.85; }
      }
      /* Subtle gold underline on tailored quotes so the visitor sees the
         line responded to THEM specifically. The vocative name does most of
         the work; this is just reinforcement. */
      .wing-quote.tg-quote-tailored {
        position: relative;
      }
      .wing-quote.tg-quote-tailored::after {
        content: '';
        position: absolute;
        left: 0; right: 30%; bottom: -0.4rem;
        height: 1px;
        background: linear-gradient(90deg, var(--gold-light, #d4aa4a), transparent);
        opacity: 0.6;
      }
      .corridor-wing.wing-right .wing-quote.tg-quote-tailored::after {
        left: 30%; right: 0;
        background: linear-gradient(270deg, var(--gold-light, #d4aa4a), transparent);
      }
      /* Personalized invitation on the wing-link. Brighter than the
         default to signal it speaks specifically to this visitor. */
      .wing-link.tg-link-tailored {
        color: var(--gold-light, #d4aa4a);
        border-bottom-color: var(--gold-light, #d4aa4a);
      }
    `;
    const style = document.createElement('style');
    style.id = 'tg-corridor-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function setLoading(cards, on) {
    cards.forEach(c => c.quoteEl.classList.toggle('tg-quote-loading', !!on));
  }

  function applyBriefings(cards, briefings) {
    cards.forEach(c => {
      const entry = briefings ? briefings[c.epId] : null;
      // Tolerate both the new {line, invitation} shape and the old
      // single-string shape from any stale cache.
      let line = '';
      let invitation = '';
      if (entry && typeof entry === 'object') {
        line       = String(entry.line       || '').trim();
        invitation = String(entry.invitation || '').trim();
      } else if (typeof entry === 'string') {
        line = entry.trim();
      }

      if (line) {
        c.quoteEl.textContent = '"' + line + '"';
        c.quoteEl.classList.add('tg-quote-tailored');
      }
      // Personalized invitation replaces the static "Step into her
      // office" link text. We keep the href (still points at the EP's
      // helper page) and just swap the label. The UI's existing arrow
      // (visible because the link has " →" in the original) needs to
      // be re-added since the model is told not to include punctuation.
      if (invitation && c.linkEl) {
        c.linkEl.textContent = invitation + ' →';
        c.linkEl.classList.add('tg-link-tailored');
      }
      // No line / no invitation: leave the static text alone.
    });
  }

  // ── Fetch + cache ──────────────────────────────────────────────────────
  async function fetchBriefings(brief, name) {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: brief, name: name }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('briefings ' + resp.status + ' ' + text.slice(0, 160));
    }
    return resp.json();
  }

  function readCache(currentSig) {
    const cachedSig = ss(KEY_CACHE_SIG);
    if (!cachedSig || cachedSig !== currentSig) return null;
    const raw = ss(KEY_CACHE);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch(_) { return null; }
  }
  function writeCache(currentSig, briefings) {
    ssSet(KEY_CACHE_SIG, currentSig);
    ssSet(KEY_CACHE, JSON.stringify(briefings));
  }
  function clearCache() {
    ssDel(KEY_CACHE_SIG);
    ssDel(KEY_CACHE);
  }

  // ── Main ──────────────────────────────────────────────────────────────
  async function run(forceRefresh) {
    const brief = (ss(KEY_BRIEF) || '').trim();
    if (!brief || brief.length < MIN_BRIEF_LEN) return;   // no brief = leave static

    const name = (ss(KEY_NAME) || '').trim();
    const cards = collectCards();
    if (!cards.length) return;                            // not on a page with the corridor

    injectStyles();

    const currentSig = sig(brief + '|' + name);

    // Cache hit: apply immediately, no network call.
    if (!forceRefresh) {
      const cached = readCache(currentSig);
      if (cached && cached.briefings) {
        applyBriefings(cards, cached.briefings);
        return;
      }
    }

    setLoading(cards, true);
    try {
      const data = await fetchBriefings(brief, name);
      setLoading(cards, false);
      if (data && data.briefings) {
        applyBriefings(cards, data.briefings);
        writeCache(currentSig, data);
      }
    } catch (err) {
      console.warn('[tg-corridor]', err.message);
      setLoading(cards, false);
      // Static quotes remain. Silent failure - no broken UI for the visitor.
    }
  }

  // Public escape hatch. Downstream slices (Card 2 pitch modal, Ivy idea
  // generator) will call this after they update the brief in session.
  window.TGCorridor = {
    refresh: function(){ run(true); },
    clearCache: clearCache,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => run(false));
  } else {
    run(false);
  }
})();
