/* ─────────────────────────────────────────────────────────────────────────────
   tg-ep-zoom.js — "Take it to Zoom" floating call widget.

   Layered ON TOP of the existing text-based office (Helpers/<ep>.html).
   The text view stays the working surface. This widget is the call
   presence — voice in (Speak / Web Speech API) and voice out (Voice
   toggle / ElevenLabs TTS via tg-ep-chat-voice).

   Page contract:
     - A button with [data-tg-zoom-open] in the topbar opens the widget.
     - A container with .tg-zoom-widget exists somewhere on the page
       (hidden via CSS until .is-open is added).
     - The office root [data-tg-office="ep"] provides ep id / display
       name (read from data-tg-office-ep-id / data-tg-office-ep-name).
     - The office page provides per-EP fields on <body> or the widget
       itself: data-tg-zoom-eyes-open, data-tg-zoom-eyes-closed,
       data-tg-zoom-tagline.
     - The text-based office continues to use [data-tg-office="chat"]
       as its transcript. This widget OBSERVES new assistant turns
       there for autoplay.

   Voice autoplay defaults to OFF (per session). Toggle persists in
   sessionStorage as tg_ep_voice_autoplay = "1".

   SessionStorage read:
     tg_visitor_name, tg_visitor_brief                  - for context
     tg_ep_voice_autoplay                               - autoplay flag
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  // Reuse the existing tg-voice POST endpoint - it already accepts
  // { character, text } and runs ElevenLabs TTS with the same voice
  // settings the static bio/role audio uses. No separate function needed.
  const ENDPOINT_VOICE  = '/.netlify/functions/tg-voice';
  const KEY_VOICE_AUTO  = 'tg_ep_voice_autoplay';
  const TEXT_MAX_PER_TTS = 800;   // self-imposed cap; tg-voice allows up to 1500

  function ss(k){ try { return sessionStorage.getItem(k); } catch(_) { return null; } }
  function ssSet(k, v){ try { sessionStorage.setItem(k, v); } catch(_) {} }
  function ssDel(k){ try { sessionStorage.removeItem(k); } catch(_) {} }

  function init() {
    const officeRoot = document.querySelector('[data-tg-office="ep"]');
    const widget     = document.querySelector('.tg-zoom-widget');
    const opener     = document.querySelector('[data-tg-zoom-open]');
    if (!officeRoot || !widget || !opener) return;   // not zoom-enabled

    const epId       = officeRoot.dataset.tgOfficeEpId || '';
    const epName     = officeRoot.dataset.tgOfficeEpName || epId.replace(/_/g, ' ');
    const tagline    = widget.dataset.tgZoomTagline || officeRoot.dataset.tgZoomTagline || '';
    const eyesOpen   = widget.dataset.tgZoomEyesOpen   || officeRoot.dataset.tgZoomEyesOpen   || '';
    const eyesClosed = widget.dataset.tgZoomEyesClosed || officeRoot.dataset.tgZoomEyesClosed || '';

    // Populate the widget header + portrait from data attrs. The page can
    // also hard-code these inside the .tg-zoom-widget markup; the JS only
    // fills in elements it finds.
    function populate() {
      const nameEl    = widget.querySelector('[data-tg-zoom="name"]');
      const tagEl     = widget.querySelector('[data-tg-zoom="tagline"]');
      const openImg   = widget.querySelector('.tg-zoom-blink-open');
      const closedImg = widget.querySelector('.tg-zoom-blink-closed');
      if (nameEl && !nameEl.textContent.trim()) nameEl.textContent = epName;
      if (tagEl  && tagline)                    tagEl.textContent  = tagline;
      if (openImg   && eyesOpen   && !openImg.getAttribute('src'))   openImg.src   = eyesOpen;
      if (closedImg && eyesClosed && !closedImg.getAttribute('src')) closedImg.src = eyesClosed;
    }
    populate();

    const statusPill = widget.querySelector('.tg-zoom-status');
    const statusText = widget.querySelector('[data-tg-zoom="status-text"]');
    const closeBtn   = widget.querySelector('.tg-zoom-close');
    const speakBtn   = widget.querySelector('.tg-zoom-speak');
    const voiceBtn   = widget.querySelector('.tg-zoom-voice');
    const replayBtn  = widget.querySelector('.tg-zoom-replay');

    // First-tap mic-permission heads-up. The browser prompts the first
    // time Speak is used per origin; without warning, visitors think the
    // app is broken. Injected (not hard-coded in 9 office HTMLs) and
    // intentionally generic - no domain name, so a URL change leaves it
    // accurate.
    (function injectMicNote() {
      const controls = widget.querySelector('.tg-zoom-controls');
      if (!controls) return;
      if (widget.querySelector('.tg-zoom-mic-note')) return; // idempotent
      const note = document.createElement('div');
      note.className = 'tg-zoom-mic-note';
      note.innerHTML = 'First tap on <strong>Speak</strong>, your browser will ask to use the mic. Say <strong>yes</strong>.';
      controls.insertAdjacentElement('afterend', note);
    })();

    const inputEl   = document.querySelector('[data-tg-office="input"]');
    const chatEl    = document.querySelector('[data-tg-office="chat"]');

    function setStatus(mode) {
      if (!statusText) return;
      if (mode === 'thinking') {
        statusText.textContent = epName + ' is reading';
        statusPill && statusPill.classList.add('is-thinking');
      } else if (mode === 'speaking') {
        statusText.textContent = epName + ' is speaking';
        statusPill && statusPill.classList.add('is-thinking');
        widget.classList.add('is-speaking');
      } else {
        statusText.textContent = epName + ' is ready. Ask anything.';
        statusPill && statusPill.classList.remove('is-thinking');
        widget.classList.remove('is-speaking');
      }
    }
    setStatus('ready');

    // ── Open / close ────────────────────────────────────────────────────
    function open() {
      widget.classList.add('is-open');
    }
    function close() {
      widget.classList.remove('is-open');
      // If audio is playing, stop it.
      if (state.currentAudio) {
        try { state.currentAudio.pause(); state.currentAudio.currentTime = 0; } catch(_){}
        state.currentAudio = null;
      }
      // If a share-screen is up, dismiss it too. The underlying revision
      // stays pending in the chat thread so the visitor can still act on
      // it from there - we just stop SHOWING it on the widget.
      widget.classList.remove('is-sharing');
      state.activeRevisionIdx = null;
      setStatus('ready');
    }
    opener.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);

    // ── State ───────────────────────────────────────────────────────────
    const state = {
      voiceAutoplay:     ss(KEY_VOICE_AUTO) === '1',
      currentAudio:      null,
      lastAssistantText: '',
      // Stage B: tracks which revision idx is currently visible on the
      // share-screen. Used to avoid re-rendering on every chat mutation
      // when the same revision is still pending.
      activeRevisionIdx: null,
    };

    function applyVoiceUi() {
      if (!voiceBtn) return;
      voiceBtn.classList.toggle('is-on', state.voiceAutoplay);
      voiceBtn.setAttribute('aria-pressed', state.voiceAutoplay ? 'true' : 'false');
      const label = voiceBtn.querySelector('[data-tg-zoom="voice-label"]');
      if (label) label.textContent = state.voiceAutoplay ? 'Voice: ON' : 'Voice: OFF';
      voiceBtn.title = state.voiceAutoplay
        ? 'Voice autoplay ON — new responses play automatically'
        : 'Voice autoplay OFF — click Hear again to replay';
    }
    if (voiceBtn) {
      applyVoiceUi();
      voiceBtn.addEventListener('click', () => {
        state.voiceAutoplay = !state.voiceAutoplay;
        if (state.voiceAutoplay) ssSet(KEY_VOICE_AUTO, '1');
        else                     ssDel(KEY_VOICE_AUTO);
        applyVoiceUi();
      });
    }

    // ── Speak (Web Speech API) ──────────────────────────────────────────
    if (speakBtn) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR || !inputEl) {
        speakBtn.disabled = true;
        speakBtn.title    = 'Voice input not supported in this browser.';
      } else {
        const rec = new SR();
        rec.continuous     = false;
        rec.interimResults = true;
        rec.lang           = 'en-US';
        let listening = false;
        let collected = '';

        speakBtn.addEventListener('click', () => {
          if (listening) { rec.stop(); return; }
          collected = '';
          try { rec.start(); } catch(_) {}
        });
        rec.addEventListener('start', () => {
          listening = true;
          speakBtn.classList.add('is-listening');
        });
        rec.addEventListener('end', () => {
          listening = false;
          speakBtn.classList.remove('is-listening');
          if (collected.trim()) {
            inputEl.value = collected.trim();
            inputEl.focus();
          }
        });
        rec.addEventListener('result', (e) => {
          let text = '';
          for (let i = 0; i < e.results.length; i++) {
            text += e.results[i][0].transcript;
          }
          collected = text;
          inputEl.value = text;
        });
        rec.addEventListener('error', () => {
          listening = false;
          speakBtn.classList.remove('is-listening');
        });
      }
    }

    // ── Voice playback (ElevenLabs via tg-ep-chat-voice) ───────────────
    async function speakText(text, button) {
      if (!text) return;
      // Stop any current audio first.
      if (state.currentAudio) {
        try { state.currentAudio.pause(); state.currentAudio.currentTime = 0; } catch(_){}
        state.currentAudio = null;
      }
      if (button) button.classList.add('is-playing');
      setStatus('speaking');

      let blob;
      try {
        const resp = await fetch(ENDPOINT_VOICE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            character: epId,
            text:      text.slice(0, TEXT_MAX_PER_TTS),
          }),
        });
        if (!resp.ok) throw new Error('voice ' + resp.status);
        blob = await resp.blob();
      } catch (err) {
        console.warn('[tg-ep-zoom] voice fetch failed', err && err.message);
        if (button) button.classList.remove('is-playing');
        setStatus('ready');
        return;
      }

      const url   = URL.createObjectURL(blob);
      const audio = new Audio(url);
      state.currentAudio = audio;
      audio.addEventListener('ended', () => {
        if (button) button.classList.remove('is-playing');
        if (state.currentAudio === audio) state.currentAudio = null;
        URL.revokeObjectURL(url);
        setStatus('ready');
      });
      audio.addEventListener('error', () => {
        if (button) button.classList.remove('is-playing');
        if (state.currentAudio === audio) state.currentAudio = null;
        setStatus('ready');
      });
      try { await audio.play(); }
      catch (_err) {
        if (button) button.classList.remove('is-playing');
        if (state.currentAudio === audio) state.currentAudio = null;
        setStatus('ready');
      }
    }

    if (replayBtn) {
      replayBtn.addEventListener('click', () => {
        if (!state.lastAssistantText) return;
        speakText(state.lastAssistantText, replayBtn);
      });
      replayBtn.disabled = true;   // until we have something to replay
    }

    // ── Observe new assistant turns in the chat for autoplay ────────────
    function extractLastAssistantText() {
      if (!chatEl) return '';
      // Each assistant turn is rendered as .tg-chat-turn.tg-chat-assistant
      // by tg-ep-chat.js. The .tg-chat-content child holds the text.
      const turns = chatEl.querySelectorAll('.tg-chat-turn.tg-chat-assistant');
      if (!turns.length) return '';
      const last  = turns[turns.length - 1];
      const body  = last.querySelector('.tg-chat-content');
      return body ? String(body.textContent || '').trim() : '';
    }

    // ── Stage B: share-screen view ──────────────────────────────────────
    // The widget's center stage swaps from blinking portrait to a "shared
    // screen" view when the EP proposes a new revision in chat. Portrait
    // shrinks to a PIP, the diff goes front and center, accept/reject
    // live inside the widget. Forwarding the click to the original
    // chat-thread button keeps the brief-mutation logic in tg-ep-chat.js
    // as the single source of truth.
    const screenEl = (function injectShareScreen() {
      const stage = widget.querySelector('.tg-zoom-stage');
      if (!stage) return null;
      const div = document.createElement('div');
      div.className = 'tg-zoom-screen';
      div.innerHTML = ''
        + '<div class="tg-zoom-screen-head">'
        +   '<div class="tg-zoom-screen-eyebrow" data-tg-zoom="screen-eyebrow">Sharing screen</div>'
        +   '<div class="tg-zoom-screen-label" data-tg-zoom="screen-label"></div>'
        + '</div>'
        + '<div class="tg-zoom-screen-body" data-tg-zoom="screen-body"></div>'
        + '<div class="tg-zoom-screen-actions">'
        +   '<button class="tg-zoom-screen-btn tg-zoom-screen-accept" type="button" data-tg-zoom="screen-accept">Accept</button>'
        +   '<button class="tg-zoom-screen-btn tg-zoom-screen-reject" type="button" data-tg-zoom="screen-reject">Reject</button>'
        +   '<button class="tg-zoom-screen-btn tg-zoom-screen-stop" type="button" data-tg-zoom="screen-stop" title="Stop sharing (keeps the revision pending in the transcript)">Stop sharing</button>'
        + '</div>';
      // Place screen BEFORE the portrait so the portrait can absolute-
      // position itself as the PIP overlay when sharing.
      const portrait = stage.querySelector('.tg-zoom-portrait');
      if (portrait) stage.insertBefore(div, portrait);
      else stage.appendChild(div);
      return div;
    })();

    const screenEyebrow = screenEl && screenEl.querySelector('[data-tg-zoom="screen-eyebrow"]');
    const screenLabel   = screenEl && screenEl.querySelector('[data-tg-zoom="screen-label"]');
    const screenBody    = screenEl && screenEl.querySelector('[data-tg-zoom="screen-body"]');
    const screenAccept  = screenEl && screenEl.querySelector('[data-tg-zoom="screen-accept"]');
    const screenReject  = screenEl && screenEl.querySelector('[data-tg-zoom="screen-reject"]');
    const screenStop    = screenEl && screenEl.querySelector('[data-tg-zoom="screen-stop"]');

    function escapeHtml(s){
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function stopSharing() {
      widget.classList.remove('is-sharing');
      state.activeRevisionIdx = null;
      setStatus('ready');
    }

    // Find the pending revision card in the chat. Returns null if none.
    // A "pending" revision is a .tg-chat-revision element that is NOT
    // .is-accepted or .is-rejected.
    function findPendingRevision() {
      if (!chatEl) return null;
      const cards = chatEl.querySelectorAll('.tg-chat-revision');
      if (!cards.length) return null;
      // The LAST pending card is the most recent proposal.
      for (let i = cards.length - 1; i >= 0; i--) {
        const c = cards[i];
        if (c.classList.contains('is-accepted')) continue;
        if (c.classList.contains('is-rejected')) continue;
        // Only consider cards that actually have a diff (a pending card
        // has .tg-chat-rev-diff and accept/reject buttons).
        if (!c.querySelector('.tg-chat-rev-diff')) continue;
        return c;
      }
      return null;
    }

    function readRevisionFromCard(card) {
      if (!card) return null;
      const operation = card.getAttribute('data-op') || 'replace';
      const labelEl   = card.querySelector('.tg-chat-rev-head strong');
      const ratEl     = card.querySelector('.tg-chat-rev-rationale');
      const beforeEl  = card.querySelector('.tg-chat-rev-before');
      const afterEl   = card.querySelector('.tg-chat-rev-after');
      const acceptBtn = card.querySelector('[data-tg-rev-action="accept"]');
      const rejectBtn = card.querySelector('[data-tg-rev-action="reject"]');
      const revIdx    = acceptBtn ? acceptBtn.getAttribute('data-tg-rev-idx') : null;
      return {
        operation:    operation,
        sectionLabel: labelEl  ? labelEl.textContent.trim()  : 'this section',
        rationale:    ratEl    ? ratEl.textContent.trim()    : '',
        before:       beforeEl ? beforeEl.textContent        : '',
        after:        afterEl  ? afterEl.textContent         : '',
        idx:          revIdx,
        acceptBtn:    acceptBtn,
        rejectBtn:    rejectBtn,
      };
    }

    function renderShareScreen(rev) {
      if (!screenEl || !rev) return;
      const opLabel = rev.operation === 'append' ? 'Proposed addition' : 'Proposed rewrite';
      const verb    = rev.operation === 'append' ? 'addition' : 'rewrite';
      if (screenEyebrow) screenEyebrow.textContent = epName + ' is sharing — ' + opLabel;
      if (screenLabel)   screenLabel.textContent   = rev.sectionLabel;
      if (screenBody) {
        let html = '';
        if (rev.rationale) {
          html += '<div class="tg-zoom-screen-rationale">' + escapeHtml(rev.rationale) + '</div>';
        }
        if (rev.operation === 'append') {
          html += '<div class="tg-zoom-screen-diff">'
               +   '<div class="tg-zoom-screen-after">' + escapeHtml(rev.after) + '</div>'
               + '</div>';
        } else {
          html += '<div class="tg-zoom-screen-diff">'
               +   '<div class="tg-zoom-screen-before">' + escapeHtml(rev.before) + '</div>'
               +   '<div class="tg-zoom-screen-arrow">becomes</div>'
               +   '<div class="tg-zoom-screen-after">'  + escapeHtml(rev.after)  + '</div>'
               + '</div>';
        }
        screenBody.innerHTML = html;
      }
      if (screenAccept) screenAccept.textContent = 'Accept ' + verb;
      state.activeRevisionIdx = rev.idx;
    }

    function activateShareScreen() {
      const card = findPendingRevision();
      if (!card) return false;
      const rev = readRevisionFromCard(card);
      if (!rev || !rev.acceptBtn) return false;
      renderShareScreen(rev);
      widget.classList.add('is-sharing');
      // Make sure the widget itself is open so the visitor sees the share.
      if (!widget.classList.contains('is-open')) open();
      return true;
    }

    // Wire share-screen buttons. Accept / Reject FORWARD the click to the
    // original chat-thread button so tg-ep-chat.js mutates state in one
    // place. The MutationObserver below will see the card transition to
    // .is-accepted or .is-rejected and dismiss the share-screen view.
    if (screenAccept) {
      screenAccept.addEventListener('click', () => {
        const card = findPendingRevision();
        const rev  = readRevisionFromCard(card);
        if (rev && rev.acceptBtn) rev.acceptBtn.click();
      });
    }
    if (screenReject) {
      screenReject.addEventListener('click', () => {
        const card = findPendingRevision();
        const rev  = readRevisionFromCard(card);
        if (rev && rev.rejectBtn) rev.rejectBtn.click();
      });
    }
    if (screenStop) {
      screenStop.addEventListener('click', () => stopSharing());
    }

    if (chatEl) {
      // Initial pass — capture any assistant text already present.
      state.lastAssistantText = extractLastAssistantText();
      if (state.lastAssistantText && replayBtn) replayBtn.disabled = false;
      // If a revision was already pending when the widget loaded, share it.
      activateShareScreen();

      const observer = new MutationObserver(() => {
        const t = extractLastAssistantText();
        if (t && t !== state.lastAssistantText) {
          const wasEmpty = !state.lastAssistantText;
          state.lastAssistantText = t;
          if (replayBtn) replayBtn.disabled = false;
          // Autoplay only if Voice toggle is ON AND the widget is currently
          // open (visitor opted into the call presence). Honors the
          // no-autoplay-on-scroll rule for visitors who never opened Zoom.
          if (state.voiceAutoplay && widget.classList.contains('is-open')) {
            speakText(t, replayBtn);
          }
          // Status flash on first assistant message to draw the eye.
          if (wasEmpty) setStatus('ready');
        }

        // Share-screen state machine.
        const pending = findPendingRevision();
        if (pending) {
          // A new (or unchanged) pending revision exists.
          const rev    = readRevisionFromCard(pending);
          const sameAsActive = rev && rev.idx === state.activeRevisionIdx;
          if (!sameAsActive) {
            activateShareScreen();
          }
        } else if (widget.classList.contains('is-sharing')) {
          // No pending revision anymore - card was accepted or rejected,
          // or replaced. Dismiss share-screen.
          stopSharing();
        }
      });
      observer.observe(chatEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
