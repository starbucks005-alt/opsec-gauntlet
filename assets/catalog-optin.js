/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — No-GP-Imprint Catalog Opt-In Modal

   Per-work, contextual opt-in. The User Agreement signed at signup grants the
   legal right; this modal asks the author a second, explicit yes for THIS
   specific work. Catalog inclusion is treated as a deliberate per-work
   choice, never inferred from TOS.

   Usage from any GP tool:
     <script src="assets/catalog-optin.js"></script>
     // when the user has produced a finished/exportable artifact:
     GPCatalogOptIn.maybePrompt({ tool: 'workshop', suggestedTitle: '...' });

   Behavior:
   - First-time per (tool, day): renders a styled modal asking title, genre,
     external publication URL, and a defaulted-OFF "include me" checkbox.
   - Submit posts to /.netlify/functions/catalog-add with listing_type='made_with_gp'.
   - Dismissal/submit sets a 24h localStorage flag to avoid pestering on
     subsequent artifacts in the same tool. Different tools prompt independently.
   - Requires the page to have a Supabase client at window.sb (most GP tools do).
     If sb is missing or the user is signed out, prompt is silently skipped.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.GPCatalogOptIn) return;  // singleton

  const STORAGE_KEY = 'gp_catalog_optin_v1';
  const SUPPRESS_HOURS = 24;
  const FN_URL = '/.netlify/functions/catalog-add';

  function readSuppress() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }
  function writeSuppress(map) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch {}
  }
  function isSuppressed(tool) {
    const map = readSuppress();
    const ts = map[tool];
    if (!ts) return false;
    return Date.now() - ts < SUPPRESS_HOURS * 60 * 60 * 1000;
  }
  function markSuppressed(tool) {
    const map = readSuppress();
    map[tool] = Date.now();
    writeSuppress(map);
  }

  function ensureStyles() {
    if (document.getElementById('gp-catalog-optin-styles')) return;
    const css = `
      .gp-cm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:none;align-items:center;justify-content:center;padding:1.5rem;}
      .gp-cm-overlay.active{display:flex;}
      .gp-cm-card{background:var(--ink,#13100c);border:1px solid rgba(184,146,42,0.5);max-width:560px;width:100%;padding:2rem 2rem 1.6rem;color:var(--text,#e8dece);font-family:'Cormorant Garamond',Georgia,serif;line-height:1.55;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.6);}
      [data-theme="light"] .gp-cm-card{background:#f4ede0;color:#2a2318;}
      .gp-cm-eyebrow{font-family:'DM Mono',monospace;font-size:0.55rem;letter-spacing:0.28em;text-transform:uppercase;color:var(--gold,#b8922a);margin-bottom:0.5rem;}
      .gp-cm-title{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:700;color:var(--cream,#f4ede0);line-height:1.25;margin-bottom:0.5rem;}
      [data-theme="light"] .gp-cm-title{color:#13100c;}
      .gp-cm-sub{font-size:0.95rem;color:var(--text-dim,#9a8e7e);margin-bottom:1.2rem;}
      .gp-cm-row{display:flex;flex-direction:column;gap:0.35rem;margin-bottom:0.9rem;}
      .gp-cm-label{font-family:'DM Mono',monospace;font-size:0.58rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-dim,#9a8e7e);}
      .gp-cm-input,.gp-cm-select{background:rgba(0,0,0,0.25);border:1px solid rgba(184,146,42,0.3);color:inherit;font:inherit;padding:0.6rem 0.8rem;outline:none;}
      [data-theme="light"] .gp-cm-input,[data-theme="light"] .gp-cm-select{background:rgba(255,255,255,0.6);}
      .gp-cm-input:focus,.gp-cm-select:focus{border-color:var(--gold,#b8922a);}
      .gp-cm-row-2{display:grid;grid-template-columns:1fr 1fr;gap:1rem;}
      @media(max-width:480px){.gp-cm-row-2{grid-template-columns:1fr;}}
      .gp-cm-check{display:flex;align-items:flex-start;gap:0.6rem;border:1px solid rgba(184,146,42,0.3);background:rgba(184,146,42,0.05);padding:0.85rem 1rem;margin:0.6rem 0 1.2rem;font-size:0.92rem;line-height:1.5;cursor:pointer;}
      .gp-cm-check input{margin-top:0.25rem;flex-shrink:0;accent-color:var(--gold,#b8922a);}
      .gp-cm-actions{display:flex;gap:0.8rem;align-items:center;flex-wrap:wrap;justify-content:flex-end;}
      .gp-cm-btn-primary{background:var(--gold,#b8922a);color:#13100c;border:none;padding:0.7rem 1.4rem;font-family:'Playfair Display',serif;font-weight:700;font-size:0.95rem;cursor:pointer;letter-spacing:0.04em;}
      .gp-cm-btn-primary:hover:not(:disabled){background:var(--gold-light,#d4aa4a);}
      .gp-cm-btn-primary:disabled{opacity:0.5;cursor:not-allowed;}
      .gp-cm-btn-ghost{background:none;border:1px solid rgba(255,255,255,0.15);color:var(--text-dim,#9a8e7e);padding:0.65rem 1.1rem;font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;cursor:pointer;}
      [data-theme="light"] .gp-cm-btn-ghost{border-color:rgba(0,0,0,0.15);}
      .gp-cm-btn-ghost:hover{color:var(--text,#e8dece);}
      .gp-cm-msg{font-family:'DM Mono',monospace;font-size:0.65rem;letter-spacing:0.1em;min-height:1rem;line-height:1.4;flex:1;}
      .gp-cm-msg.err{color:#c0392b;}
      .gp-cm-msg.ok{color:#5a8c3a;}
      .gp-cm-policy{font-size:0.78rem;color:var(--text-dim,#9a8e7e);margin-top:0.6rem;line-height:1.5;}
      .gp-cm-policy a{color:var(--gold,#b8922a);}
    `;
    const tag = document.createElement('style');
    tag.id = 'gp-catalog-optin-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function buildModal() {
    if (document.getElementById('gp-cm-overlay')) return document.getElementById('gp-cm-overlay');
    const overlay = document.createElement('div');
    overlay.className = 'gp-cm-overlay';
    overlay.id = 'gp-cm-overlay';
    overlay.innerHTML = `
      <div class="gp-cm-card" role="dialog" aria-labelledby="gp-cm-title" aria-modal="true">
        <div class="gp-cm-eyebrow">Greylander Press · Guest Catalog</div>
        <h2 class="gp-cm-title" id="gp-cm-title">List your work in our public catalog?</h2>
        <p class="gp-cm-sub">You used a GP tool to make something. If you'd like, we'll list it in our <strong>Books — No GP Imprint</strong> catalog as a guest author. Optional, declinable, and per-work — your User Agreement isn't sufficient on its own; we want a yes for this specific work.</p>

        <div class="gp-cm-row">
          <label class="gp-cm-label" for="gp-cm-title-input">Title</label>
          <input class="gp-cm-input" id="gp-cm-title-input" type="text" maxlength="160" placeholder="What is this work called?">
        </div>

        <div class="gp-cm-row-2">
          <div class="gp-cm-row">
            <label class="gp-cm-label" for="gp-cm-genre">Category</label>
            <select class="gp-cm-select" id="gp-cm-genre">
              <option value="">—</option>
              <option>Fiction</option>
              <option>Nonfiction</option>
              <option>Children's / YA</option>
              <option>Poetry</option>
              <option>Other</option>
            </select>
          </div>
          <div class="gp-cm-row">
            <label class="gp-cm-label" for="gp-cm-author">Author Name</label>
            <input class="gp-cm-input" id="gp-cm-author" type="text" maxlength="80" placeholder="How should we credit you?">
          </div>
        </div>

        <div class="gp-cm-row">
          <label class="gp-cm-label" for="gp-cm-link">Where it's published (optional)</label>
          <input class="gp-cm-input" id="gp-cm-link" type="url" maxlength="500" placeholder="https://amazon.com/dp/... or your site">
        </div>

        <div class="gp-cm-row">
          <label class="gp-cm-label" for="gp-cm-blurb">Short note (optional)</label>
          <input class="gp-cm-input" id="gp-cm-blurb" type="text" maxlength="280" placeholder="One line about it (or leave blank)">
        </div>

        <label class="gp-cm-check">
          <input type="checkbox" id="gp-cm-consent">
          <span>Yes — list this work in the public Greylander Press <em>Books — No GP Imprint</em> catalog as a guest author. I understand this is per-work and that submissions are subject to editorial review.</span>
        </label>

        <div class="gp-cm-actions">
          <span class="gp-cm-msg" id="gp-cm-msg"></span>
          <button class="gp-cm-btn-ghost" id="gp-cm-skip" type="button">No thanks</button>
          <button class="gp-cm-btn-primary" id="gp-cm-submit" type="button" disabled>Submit →</button>
        </div>

        <div class="gp-cm-policy">Approved listings appear at <a href="catalog.html" target="_blank" rel="noopener">greylanderpress.com/catalog</a>. We don't edit your blurb or title.</div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function open(opts) {
    ensureStyles();
    const overlay = buildModal();
    const titleInput  = overlay.querySelector('#gp-cm-title-input');
    const genreInput  = overlay.querySelector('#gp-cm-genre');
    const authorInput = overlay.querySelector('#gp-cm-author');
    const linkInput   = overlay.querySelector('#gp-cm-link');
    const blurbInput  = overlay.querySelector('#gp-cm-blurb');
    const consent     = overlay.querySelector('#gp-cm-consent');
    const submitBtn   = overlay.querySelector('#gp-cm-submit');
    const skipBtn     = overlay.querySelector('#gp-cm-skip');
    const msg         = overlay.querySelector('#gp-cm-msg');

    if (opts && opts.suggestedTitle && !titleInput.value) titleInput.value = String(opts.suggestedTitle).slice(0, 160);
    if (opts && opts.suggestedAuthor && !authorInput.value) authorInput.value = String(opts.suggestedAuthor).slice(0, 80);

    msg.className = 'gp-cm-msg';
    msg.textContent = '';
    submitBtn.disabled = !consent.checked;

    consent.onchange = () => { submitBtn.disabled = !consent.checked; };

    skipBtn.onclick = () => {
      markSuppressed(opts && opts.tool ? opts.tool : 'unknown');
      close(overlay);
    };

    submitBtn.onclick = async () => {
      const title  = titleInput.value.trim();
      const genre  = genreInput.value.trim();
      const author = authorInput.value.trim();
      const link   = linkInput.value.trim();
      const blurb  = blurbInput.value.trim();
      if (!title) { msg.className = 'gp-cm-msg err'; msg.textContent = 'Title is required.'; return; }
      if (!consent.checked) { msg.className = 'gp-cm-msg err'; msg.textContent = 'Tick the consent box to submit.'; return; }

      submitBtn.disabled = true;
      msg.className = 'gp-cm-msg';
      msg.textContent = 'Submitting…';

      // Auth: pull from any Supabase client the host page exposes (sb, _gpSb).
      // sitenav.js sets window._gpSb / window._gpSession on most GP pages.
      let accessToken = null;
      try {
        if (window._gpSession?.access_token) {
          accessToken = window._gpSession.access_token;
        }
        if (!accessToken) {
          const client = window.sb || window._gpSb;
          if (client && client.auth) {
            const { data } = await client.auth.getSession();
            accessToken = data?.session?.access_token || null;
          }
        }
      } catch {}
      if (!accessToken) {
        msg.className = 'gp-cm-msg err';
        msg.textContent = 'Sign in to list a work. (No charge — this is a public catalog listing.)';
        submitBtn.disabled = false;
        return;
      }

      const payload = {
        title,
        author_name: author || null,
        genre: genre || null,
        project_type: opts && opts.tool ? opts.tool : null,
        blurb: [blurb, link ? `Published: ${link}` : ''].filter(Boolean).join(' · ') || null,
        listing_type: 'made_with_gp',
      };

      try {
        const res = await fetch(FN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          msg.className = 'gp-cm-msg err';
          msg.textContent = data.error || ('HTTP ' + res.status);
          submitBtn.disabled = false;
          return;
        }
        msg.className = 'gp-cm-msg ok';
        msg.textContent = 'Submitted for editorial review. We\'ll list it once approved.';
        markSuppressed(opts && opts.tool ? opts.tool : 'unknown');
        setTimeout(() => close(overlay), 1500);
      } catch (err) {
        msg.className = 'gp-cm-msg err';
        msg.textContent = 'Network error: ' + (err.message || String(err));
        submitBtn.disabled = false;
      }
    };

    overlay.classList.add('active');
    setTimeout(() => titleInput.focus(), 50);
  }

  function close(overlay) {
    overlay = overlay || document.getElementById('gp-cm-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  window.GPCatalogOptIn = {
    maybePrompt(opts) {
      const tool = opts && opts.tool ? opts.tool : 'unknown';
      if (isSuppressed(tool)) return false;
      // Defer the open by a tick so the host tool's result UI renders first
      setTimeout(() => open(opts || {}), 600);
      return true;
    },
    promptNow(opts) { open(opts || {}); return true; },
    reset() {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    },
  };
})();
