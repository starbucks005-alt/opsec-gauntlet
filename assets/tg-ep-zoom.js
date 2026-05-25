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
      setStatus('ready');
    }
    opener.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);

    // ── State ───────────────────────────────────────────────────────────
    const state = {
      voiceAutoplay: ss(KEY_VOICE_AUTO) === '1',
      currentAudio:  null,
      lastAssistantText: '',
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

    if (chatEl) {
      // Initial pass — capture any assistant text already present.
      state.lastAssistantText = extractLastAssistantText();
      if (state.lastAssistantText && replayBtn) replayBtn.disabled = false;

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
      });
      observer.observe(chatEl, { childList: true, subtree: true, characterData: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
