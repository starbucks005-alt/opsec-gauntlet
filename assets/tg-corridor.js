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
  // Hard cap on how long we wait for the briefings endpoint before we
  // give the visitor a clear failure state. Netlify sync functions cap
  // at 26s, so 30s gives a small grace window for network + edge.
  const FETCH_TIMEOUT_MS = 30000;

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
      const nameEl  = card.querySelector('.wing-name');
      if (!button || !quoteEl) return;
      const epName = nameEl ? nameEl.textContent.trim() : '';
      cards.push({
        epId:    button.dataset.character,
        epName:  epName,
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
      /* Status banner injected above the corridor cards. Shown only while
         briefings are loading or after a fetch failure. */
      .tg-corridor-status {
        max-width: 720px;
        margin: 0 auto 1.5rem;
        padding: 0.7rem 1rem;
        text-align: center;
        font-family: 'DM Mono', monospace;
        font-size: 0.6rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--text-dim, #a89c88);
        border: 1px solid var(--rule, rgba(184,146,42,0.18));
        background: rgba(184,146,42,0.04);
      }
      .tg-corridor-status.is-error {
        color: var(--gauntlet-consequence, #c0392b);
        border-color: rgba(192,57,43,0.35);
        background: rgba(192,57,43,0.04);
      }
      .tg-corridor-status .pulse {
        display: inline-block;
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--gold-light, #d4aa4a);
        margin-right: 0.55rem;
        vertical-align: middle;
        animation: tg-corridor-pulse 1.4s ease-in-out infinite;
      }
      @keyframes tg-corridor-pulse {
        0%, 100% { opacity: 0.35; }
        50%      { opacity: 1; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'tg-corridor-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Replace the static voice-sample quote with a clear loading message
  // while we fetch tailored briefings. Without this the visitor sees the
  // generic quote at 55% opacity and reads it as the real thing - then
  // it pops to the personalized line, which feels like a glitch.
  //
  // The original text is stashed on the element so we can restore if the
  // fetch fails. Linktext is stashed too (collectCards already captured
  // linkOriginal but stashing on the element survives multiple refreshes).
  //
  // Per-EP placeholder ("Ms. Ivy is reading your brief...") instead of a
  // single generic line so the visitor sees that each card is individually
  // pending, not a stalled static state.
  function setLoading(cards, on) {
    cards.forEach(c => {
      if (on) {
        if (c.quoteEl.dataset.tgOriginalQuote === undefined) {
          c.quoteEl.dataset.tgOriginalQuote = c.quoteEl.textContent;
        }
        const who = c.epName || 'This EP';
        c.quoteEl.textContent = who + ' is reading your brief...';
        c.quoteEl.classList.add('tg-quote-loading');
      } else {
        c.quoteEl.classList.remove('tg-quote-loading');
      }
    });
  }

  // ── Status banner above the cards ─────────────────────────────────────
  // Single banner used for both the "still working" state and the
  // hard-failure state. Injected once, removed when the call completes
  // successfully so the corridor is clean for the normal reading flow.
  function findStatusAnchor() {
    // Prefer inserting BEFORE the first corridor card so the banner sits
    // right above the cast. Falls back to the section container.
    const firstCard = document.querySelector('.corridor-wing');
    if (firstCard && firstCard.parentNode) return { parent: firstCard.parentNode, anchor: firstCard };
    const section = document.querySelector('.corridor-wings, #corridor-wings');
    return section ? { parent: section, anchor: section.firstChild } : null;
  }
  function showStatus(msg, isError) {
    const anchor = findStatusAnchor();
    if (!anchor) return;
    let el = document.getElementById('tg-corridor-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tg-corridor-status';
      el.className = 'tg-corridor-status';
      anchor.parent.insertBefore(el, anchor.anchor);
    }
    el.classList.toggle('is-error', !!isError);
    el.innerHTML = (isError ? '' : '<span class="pulse" aria-hidden="true"></span>') + msg;
  }
  function hideStatus() {
    const el = document.getElementById('tg-corridor-status');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Restore the static voice-sample quote (used when a fetch fails -
  // better to show the generic quote than leave the loading text up).
  function restoreStatic(cards) {
    cards.forEach(c => {
      if (c.quoteEl.dataset.tgOriginalQuote !== undefined) {
        c.quoteEl.textContent = c.quoteEl.dataset.tgOriginalQuote;
      }
      c.quoteEl.classList.remove('tg-quote-loading');
    });
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
  // AbortController + 30s deadline so a slow / hung function does not
  // strand the visitor on the loading state indefinitely (pre-fix bug:
  // browser fetch has no default timeout, so a stalled Netlify edge
  // connection could hold the placeholder for minutes).
  async function fetchBriefings(brief, name) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: brief, name: name }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error('briefings ' + resp.status + ' ' + text.slice(0, 160));
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
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
        hideStatus();
        return;
      }
    }

    setLoading(cards, true);
    showStatus('Briefings usually take 10 to 20 seconds. Each EP writes their own.');
    try {
      const data = await fetchBriefings(brief, name);
      setLoading(cards, false);
      if (data && data.briefings) {
        applyBriefings(cards, data.briefings);
        writeCache(currentSig, data);
        hideStatus();
      } else {
        restoreStatic(cards);
        showStatus('Tailored briefings did not return. Refresh to try again.', true);
      }
    } catch (err) {
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-corridor]', msg);
      // Restore the static quotes so the visitor doesn't end up with
      // a per-EP "is reading your brief..." line stranded on every card.
      restoreStatic(cards);
      showStatus(
        isTimeout
          ? 'Tailored briefings timed out. Refresh to try again.'
          : 'Tailored briefings could not be generated. Refresh to try again.',
        true
      );
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
