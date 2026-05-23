/* ─────────────────────────────────────────────────────────────────────────────
   tg-voice.js — client-side voice button handler

   Wires any element with data-tg-voice to play its character's audio:
     <button data-tg-voice
             data-character="wren_calloway"
             data-mode="bio">Their Story</button>

   On click:
     - Cancels any currently-playing tg-voice audio (handles the AbortError
       race condition Terry flagged when the user mashes buttons).
     - Calls /.netlify/functions/tg-voice with character + mode.
     - Plays the returned MP3.
     - Caches the resulting object URL so repeat plays are instant.

   The script is idempotent: it auto-initializes on DOMContentLoaded and
   removes the `disabled` attribute from any wired buttons that had it as
   a placeholder. Any page including this script with voice buttons
   present will just work.
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const ENDPOINT = '/.netlify/functions/tg-voice';
  const audioCache = new Map();     // key: character|mode → blob URL
  let currentAudio = null;          // currently-playing HTMLAudioElement
  let currentButton = null;

  function key(character, mode){ return character + '|' + mode; }

  function stopCurrent(){
    if (!currentAudio) return;
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch(_){}
    if (currentButton){
      currentButton.classList.remove('is-playing');
      currentButton.removeAttribute('data-playing');
    }
    currentAudio = null;
    currentButton = null;
  }

  async function fetchAudio(character, mode){
    const k = key(character, mode);
    if (audioCache.has(k)) return audioCache.get(k);
    const url = `${ENDPOINT}?character=${encodeURIComponent(character)}&mode=${encodeURIComponent(mode)}`;
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok){
      const text = await resp.text().catch(() => '');
      throw new Error(`voice fetch ${resp.status}: ${text || resp.statusText}`);
    }
    const blob = await resp.blob();
    const objectUrl = URL.createObjectURL(blob);
    audioCache.set(k, objectUrl);
    return objectUrl;
  }

  async function handleClick(btn){
    const character = btn.dataset.character;
    const mode = btn.dataset.mode;
    if (!character || !mode) return;

    // If this exact button is already playing, treat the click as a stop.
    if (currentButton === btn && currentAudio && !currentAudio.paused){
      stopCurrent();
      return;
    }

    // Otherwise cancel any other in-flight playback first.
    stopCurrent();

    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');

    try {
      const src = await fetchAudio(character, mode);
      const audio = new Audio(src);
      currentAudio = audio;
      currentButton = btn;

      btn.classList.remove('is-loading');
      btn.removeAttribute('aria-busy');
      btn.classList.add('is-playing');
      btn.setAttribute('data-playing', 'true');

      audio.addEventListener('ended', () => {
        if (currentAudio === audio) stopCurrent();
      });
      audio.addEventListener('error', () => {
        if (currentAudio === audio) stopCurrent();
      });

      // Swallow AbortError silently. play() returns a promise that rejects
      // when interrupted by pause(); that is expected, not an error.
      try {
        await audio.play();
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        throw err;
      }
    } catch (err) {
      console.warn('[tg-voice]', err);
      btn.classList.remove('is-loading','is-playing');
      btn.removeAttribute('aria-busy');
      btn.removeAttribute('data-playing');
      if (currentAudio) currentAudio = null;
      if (currentButton === btn) currentButton = null;
    }
  }

  function init(){
    const buttons = document.querySelectorAll('[data-tg-voice]');
    buttons.forEach(btn => {
      // Remove placeholder disabled state set in the HTML before this script ran.
      if (btn.hasAttribute('disabled')) btn.removeAttribute('disabled');
      if (btn.getAttribute('title') === 'Voice integration coming with ElevenLabs'){
        btn.removeAttribute('title');
      }
      btn.addEventListener('click', () => handleClick(btn));
    });
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
