/* ─────────────────────────────────────────────────────────────────────────────
   tg-im.js — IM (direct chat with a helper) modal

   Wires any element with data-tg-im to open a chat-with-this-helper modal:
     <button data-tg-im
             data-character="wren_calloway"
             data-name="Wren">IM Wren</button>

   For now the modal is a placeholder — it announces what direct chat with
   that helper will be and points the user at the voice buttons in the
   meantime. The actual live chat plugs in during the chat-layer gate
   (post-Gate D) and reuses these data attributes; no markup changes will
   be needed on the buttons themselves.

   Helpers only. Judges evaluate in The Chamber and do not have IM.
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  let modalEl = null;

  function injectStyles(){
    if (document.getElementById('tg-im-styles')) return;
    const style = document.createElement('style');
    style.id = 'tg-im-styles';
    style.textContent = `
      .tg-im-backdrop{
        position:fixed;inset:0;background:rgba(8,6,4,0.85);
        display:none;align-items:flex-start;justify-content:center;
        padding:8vh 1.5rem;z-index:600;overflow-y:auto;
        backdrop-filter:blur(6px);
      }
      .tg-im-backdrop.is-open{display:flex;}
      .tg-im-modal{
        background:#0a0a0a;border:1px solid var(--gold,#b8922a);
        max-width:520px;width:100%;padding:2.5rem 2.5rem 2rem;
        position:relative;
        box-shadow:0 24px 60px -20px rgba(0,0,0,0.8),
                   0 0 64px -10px rgba(184,146,42,0.25);
      }
      .tg-im-close{
        position:absolute;top:0.9rem;right:1rem;
        background:none;border:none;color:#a89c88;font-size:1.6rem;
        cursor:pointer;padding:0.4rem 0.6rem;line-height:1;
      }
      .tg-im-close:hover{color:var(--gold,#b8922a);}
      .tg-im-eyebrow{
        font-family:'DM Mono',monospace;font-size:0.55rem;letter-spacing:0.28em;
        text-transform:uppercase;color:var(--gold,#b8922a);margin-bottom:0.7rem;
      }
      .tg-im-title{
        font-family:'Playfair Display',serif;font-size:1.8rem;font-weight:700;
        color:#f4ede0;line-height:1.15;margin-bottom:0.5rem;
      }
      .tg-im-title em{font-style:italic;color:var(--gold-light,#d4aa4a);}
      .tg-im-body{
        font-family:'Cormorant Garamond',serif;font-size:1.05rem;line-height:1.7;
        color:#e8dece;margin:1.5rem 0;
      }
      .tg-im-body em{color:#f4ede0;font-style:italic;}
      .tg-im-body strong{color:var(--gold-light,#d4aa4a);font-weight:700;}
      .tg-im-actions{
        display:flex;justify-content:flex-end;gap:0.8rem;
        margin-top:1.5rem;padding-top:1.3rem;
        border-top:1px solid rgba(184,146,42,0.30);
      }
      .tg-im-actions button{
        background:transparent;border:1px solid rgba(184,146,42,0.30);
        color:#a89c88;
        font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:0.2em;
        text-transform:uppercase;padding:0.65rem 1.3rem;cursor:pointer;
      }
      .tg-im-actions button:hover{border-color:var(--gold,#b8922a);color:var(--gold,#b8922a);}
    `;
    document.head.appendChild(style);
  }

  function buildModal(){
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'tg-im-backdrop';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.innerHTML = `
      <div class="tg-im-modal">
        <button class="tg-im-close" aria-label="Close">×</button>
        <div class="tg-im-eyebrow">Direct Message</div>
        <h2 class="tg-im-title" id="tg-im-title">Live chat coming soon.</h2>
        <div class="tg-im-body" id="tg-im-body"></div>
        <div class="tg-im-actions">
          <button type="button" class="tg-im-dismiss">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);

    function close(){ modalEl.classList.remove('is-open'); }
    modalEl.querySelector('.tg-im-close').addEventListener('click', close);
    modalEl.querySelector('.tg-im-dismiss').addEventListener('click', close);
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalEl.classList.contains('is-open')) close();
    });

    return modalEl;
  }

  function openFor(name){
    const modal = buildModal();
    const titleEl = modal.querySelector('#tg-im-title');
    const bodyEl = modal.querySelector('#tg-im-body');
    titleEl.innerHTML = `Live chat with <em>${escapeHtml(name)}</em> is coming soon.`;
    bodyEl.innerHTML = `
      <p>Direct messages with <strong>${escapeHtml(name)}</strong> are part of the chat layer that ships after the evaluation pipeline. When it lands, you will be able to message ${escapeHtml(name)} about your submission, ask follow-up questions, or push back on a finding. Responses will land in ${escapeHtml(name)}'s own voice.</p>
      <p>For now, hit <em>Their Story</em> or <em>Their Role</em> above to hear ${escapeHtml(name)} introduce themselves directly.</p>
    `;
    modal.classList.add('is-open');
  }

  function escapeHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function init(){
    injectStyles();
    const buttons = document.querySelectorAll('[data-tg-im]');
    buttons.forEach(btn => {
      if (btn.hasAttribute('disabled')) btn.removeAttribute('disabled');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const name = btn.dataset.name || 'this helper';
        openFor(name);
      });
    });
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
