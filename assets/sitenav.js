/* ─────────────────────────────────────────────────────────────────────────────
   assets/sitenav.js — Greylander Press global nav
   Usage: <div id="gp-nav" data-page="post"></div>
   data-page values: novice | pre | post | playground | publish | catalog | reviews
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const SB_URL  = 'https://siaagtgakcxvnktlqomx.supabase.co';
  const SB_ANON = 'sb_publishable_9VibIhxkB2kk0WnksZvTpQ_-WWYdU8R';

  const PHASES = [
    { id: 'novice',      label: 'Novice',       href: 'index.html#phase-novice' },
    { id: 'pre',         label: 'Pre-Project',  href: 'index.html#phase-pre' },
    { id: 'post',        label: 'Post Draft',   href: 'index.html#phase-post' },
    { id: 'playground',  label: 'Playground',   href: 'index.html#phase-playground' },
    { id: 'publish',     label: 'Publish',      href: 'index.html#phase-publish' },
    { id: 'catalog',     label: 'Catalog',      href: 'catalog.html' },
    { id: 'reviews',     label: 'Site Reviews', href: 'index.html#phase-site-reviews' },
  ];

  const mount = document.getElementById('gp-nav');
  if (!mount) return;

  const activePage = (mount.dataset.page || '').toLowerCase();

  /* ── Inject styles ─────────────────────────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    #gp-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 200; }
    .gp-sitenav {
      display: flex; align-items: stretch; height: 72px;
      background: rgba(19,16,12,0.96); backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(184,146,42,0.25);
    }
    .gp-sitenav-logo {
      font-family: 'Playfair Display', serif; font-size: 0.9rem;
      letter-spacing: 0.15em; text-transform: uppercase;
      color: #d4aa4a; text-decoration: none;
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0 1.5rem; border-right: 1px solid rgba(184,146,42,0.2);
      flex-shrink: 0; white-space: nowrap;
    }
    .gp-sitenav-logo img { height: 30px; width: 30px; }
    .gp-sitenav-links {
      display: flex; align-items: stretch; list-style: none;
      flex: 1; justify-content: center; margin: 0; padding: 0;
    }
    .gp-sitenav-links li { display: flex; }
    .gp-sitenav-links a {
      font-family: 'DM Mono', monospace; font-size: 0.62rem;
      letter-spacing: 0.16em; text-transform: uppercase;
      color: rgba(244,237,224,0.6); text-decoration: none;
      display: flex; align-items: center; padding: 0 1rem;
      border-bottom: 3px solid transparent;
      transition: color 0.2s, border-color 0.2s; white-space: nowrap;
    }
    .gp-sitenav-links a:hover { color: rgba(244,237,224,0.95); }
    .gp-sitenav-links a.active {
      color: #d4aa4a; border-bottom-color: #b8922a;
    }
    .gp-sitenav-auth {
      display: flex; align-items: center; gap: 6px;
      padding: 0 1rem; border-left: 1px solid rgba(184,146,42,0.2);
      flex-shrink: 0;
    }
    .gp-nav-btn {
      font-family: 'DM Mono', monospace; font-size: 0.58rem;
      letter-spacing: 0.1em; text-transform: uppercase;
      height: 28px; padding: 0 10px; display: inline-flex;
      align-items: center; gap: 4px; white-space: nowrap;
      border: none; cursor: pointer; text-decoration: none;
      transition: background 0.15s, color 0.15s;
    }
    .gp-nav-email {
      background: rgba(184,146,42,0.15); border: 1px solid rgba(184,146,42,0.4);
      color: #d4aa4a;
    }
    .gp-nav-credits {
      background: rgba(184,146,42,0.12); border: 1px solid rgba(184,146,42,0.3);
      color: #d4aa4a; cursor: default;
    }
    .gp-nav-theme {
      background: transparent; border: 1px solid rgba(244,237,224,0.15);
      color: rgba(244,237,224,0.5);
    }
    .gp-nav-theme:hover { border-color: rgba(184,146,42,0.4); color: #d4aa4a; }
    .gp-nav-signout {
      background: transparent; border: 1px solid rgba(244,237,224,0.12);
      color: rgba(244,237,224,0.4);
    }
    .gp-nav-signout:hover { border-color: rgba(184,146,42,0.4); color: #d4aa4a; }
    .gp-nav-signin {
      background: rgba(184,146,42,0.15); border: 1px solid rgba(184,146,42,0.4);
      color: #d4aa4a;
    }
    .gp-nav-signin:hover { background: rgba(184,146,42,0.28); }
    /* light mode overrides */
    [data-theme="light"] .gp-sitenav {
      background: rgba(244,237,224,0.97);
      border-bottom-color: rgba(90,65,15,0.25);
    }
    [data-theme="light"] .gp-sitenav-logo { color: #7a5c14; }
    [data-theme="light"] .gp-sitenav-links a { color: rgba(42,31,14,0.6); }
    [data-theme="light"] .gp-sitenav-links a:hover { color: #1a1208; }
    [data-theme="light"] .gp-sitenav-links a.active { color: #5e4710; border-bottom-color: #7a5c14; }
    [data-theme="light"] .gp-nav-email { background: rgba(100,75,18,0.1); border-color: rgba(100,75,18,0.4); color: #5e4710; }
    [data-theme="light"] .gp-nav-credits { background: rgba(100,75,18,0.08); border-color: rgba(100,75,18,0.3); color: #5e4710; }
    [data-theme="light"] .gp-nav-theme { border-color: rgba(42,31,14,0.2); color: rgba(42,31,14,0.5); }
    [data-theme="light"] .gp-nav-signout { border-color: rgba(42,31,14,0.15); color: rgba(42,31,14,0.4); }
  `;
  document.head.appendChild(style);

  /* ── Body offset ───────────────────────────────────────────────────────────── */
  // Shift body content below the fixed nav
  document.body.style.paddingTop = '72px';

  /* ── Theme helpers ─────────────────────────────────────────────────────────── */
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'auto';
  }
  function themeLabel(t) {
    return t === 'light' ? '◑ Light' : t === 'dark' ? '◐ Dark' : '◐ Auto';
  }
  function cycleTheme() {
    const t = currentTheme();
    const next = t === 'auto' ? 'dark' : t === 'dark' ? 'light' : 'auto';
    if (next === 'auto') {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('gp-theme');
    } else {
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('gp-theme', next);
    }
    document.querySelectorAll('.gp-nav-theme').forEach(b => b.textContent = themeLabel(next));
  }

  /* ── Render ────────────────────────────────────────────────────────────────── */
  const linksHtml = PHASES.map(p =>
    `<li><a href="${p.href}"${activePage === p.id ? ' class="active"' : ''}>${p.label}</a></li>`
  ).join('');

  mount.innerHTML = `
    <nav class="gp-sitenav">
      <a href="index.html" class="gp-sitenav-logo">
        <img src="gp-logo.png" alt="GP"> Greylander Press
      </a>
      <ul class="gp-sitenav-links">${linksHtml}</ul>
      <div class="gp-sitenav-auth" id="gp-sitenav-auth">
        <button class="gp-nav-btn gp-nav-theme" onclick="(function(){var t=document.documentElement.getAttribute('data-theme')||'auto';var n=t==='auto'?'dark':t==='dark'?'light':'auto';if(n==='auto'){document.documentElement.removeAttribute('data-theme');localStorage.removeItem('gp-theme');}else{document.documentElement.setAttribute('data-theme',n);localStorage.setItem('gp-theme',n);}document.querySelectorAll('.gp-nav-theme').forEach(function(b){b.textContent=n==='light'?'◑ Light':n==='dark'?'◐ Dark':'◐ Auto';});})()">${themeLabel(currentTheme())}</button>
      </div>
    </nav>
  `;

  /* ── Auth (async) ──────────────────────────────────────────────────────────── */
  (async function () {
    try {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      const sb = createClient(SB_URL, SB_ANON);
      window._gpSb = sb; // share client immediately so pages can reuse it
      const r  = await sb.auth.getSession();
      const session = r?.data?.session ?? null;
      window._gpSession = session;
      window.dispatchEvent(new CustomEvent('gp-auth-ready', { detail: { session, sb } }));
      const auth = document.getElementById('gp-sitenav-auth');
      if (!auth) return;

      const themeBtn = `<button class="gp-nav-btn gp-nav-theme" id="gp-nav-theme-btn">${themeLabel(currentTheme())}</button>`;

      if (!session?.user) {
        auth.innerHTML = `
          <a href="index.html#auth" class="gp-nav-btn gp-nav-signin">Sign In</a>
          ${themeBtn}
        `;
      } else {
        const email = session.user.email;
        const short = email.length > 22 ? email.slice(0, 20) + '…' : email;
        const { data: creds } = await sb.from('gp_credits').select('balance').eq('user_id', session.user.id).single();
        const bal = creds?.balance ?? 0;

        auth.innerHTML = `
          <span class="gp-nav-btn gp-nav-email">${short}</span>
          <span class="gp-nav-btn gp-nav-credits">✦ ${bal.toLocaleString()} cr</span>
          ${themeBtn}
          <button class="gp-nav-btn gp-nav-signout" id="gp-nav-signout">↯ Sign Out</button>
        `;

        document.getElementById('gp-nav-signout').onclick = async () => {
          await sb.auth.signOut();
          location.reload();
        };
      }

      document.getElementById('gp-nav-theme-btn').onclick = cycleTheme;
    } catch (e) {
      // Ensure waiting pages don't hang if sitenav errors
      if (typeof window._gpSession === 'undefined') {
        window._gpSession = null;
        window.dispatchEvent(new CustomEvent('gp-auth-ready', { detail: { session: null, sb: window._gpSb ?? null } }));
      }
    }
  })();
})();
