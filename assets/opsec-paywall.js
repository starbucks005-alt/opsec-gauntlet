/* opsec-paywall.js — subscription gate for OPSEC Gauntlet.
   On landing page (/): shows paywall modal if no active subscription.
   On downstream pages (intake, chamber, report): redirects to / instead.
   Dev bypass: ?dev=etl2026 in URL skips the gate and stores in sessionStorage. */

(function() {
  var STORAGE_KEY = 'opsec_access';
  var DEV_SS_KEY  = 'opsec_dev';
  var DEV_VALUE   = 'etl2026';
  var ACCESS_TTL  = 31 * 24 * 60 * 60 * 1000;   // 31 days
  var RENEW_WIN   =  7 * 24 * 60 * 60 * 1000;   // re-verify if < 7 days left

  function getStored() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch(_) { return null; }
  }
  function setStored(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch(_) {}
  }
  function clearStored() {
    try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
  }

  function isDevMode(params) {
    return (params.get('dev') === DEV_VALUE) || (sessionStorage.getItem(DEV_SS_KEY) === DEV_VALUE);
  }
  function storeDevMode() {
    try { sessionStorage.setItem(DEV_SS_KEY, DEV_VALUE); } catch(_) {}
  }

  var isLanding = (window.location.pathname === '/' || window.location.pathname === '/index.html');

  function cleanUrl() {
    if (window.location.search) history.replaceState(null, '', window.location.pathname);
  }

  function showModal() {
    if (document.getElementById('opsec-pw')) return;

    var style = document.createElement('style');
    style.textContent = [
      '#opsec-pw{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;}',
      '#opsec-pw-bg{position:absolute;inset:0;background:rgba(10,10,10,0.94);backdrop-filter:blur(8px);}',
      '#opsec-pw-box{position:relative;background:#0e0e12;border:1px solid rgba(168,42,42,0.4);',
        'padding:2.8rem 2.2rem;max-width:420px;width:calc(100% - 2rem);text-align:center;',
        'box-shadow:0 0 100px rgba(168,42,42,0.12);}',
      '.pw-eyebrow{font-family:"Public Sans",sans-serif;font-size:0.52rem;letter-spacing:0.3em;',
        'font-weight:700;color:#c0392b;text-transform:uppercase;margin-bottom:1.1rem;}',
      '.pw-seal{margin-bottom:1rem;}',
      '.pw-seal img{opacity:0.8;display:block;margin:0 auto;}',
      '.pw-title{font-family:"Spectral",serif;font-size:1.85rem;color:#F9F8F4;margin-bottom:0.5rem;font-weight:700;}',
      '.pw-lede{font-family:"Public Sans",sans-serif;font-size:0.8rem;color:#a89c88;',
        'line-height:1.65;margin-bottom:1.6rem;}',
      '.pw-price{display:flex;align-items:baseline;justify-content:center;gap:0.25rem;margin-bottom:0.35rem;}',
      '.pw-amount{font-family:"Spectral",serif;font-size:2.6rem;color:#F9F8F4;font-weight:700;line-height:1;}',
      '.pw-period{font-family:"Public Sans",sans-serif;font-size:0.85rem;color:#a89c88;}',
      '.pw-detail{font-family:"Public Sans",sans-serif;font-size:0.68rem;color:#7d735f;',
        'letter-spacing:0.06em;margin-bottom:1.8rem;}',
      '#opsec-pw-btn{width:100%;padding:1rem;background:#a82a2a;border:none;color:#fff;',
        'font-family:"Public Sans",sans-serif;font-size:0.7rem;font-weight:700;',
        'letter-spacing:0.2em;text-transform:uppercase;cursor:pointer;transition:background 0.18s;}',
      '#opsec-pw-btn:hover{background:#c0392b;}',
      '#opsec-pw-btn:disabled{background:#3d1010;cursor:wait;}',
      '#opsec-pw-err{display:none;margin-top:0.75rem;font-family:"Public Sans",sans-serif;',
        'font-size:0.68rem;color:#c0392b;letter-spacing:0.04em;}',
      '.pw-restore-row{margin-top:1.1rem;font-family:"Public Sans",sans-serif;font-size:0.62rem;color:#7d735f;}',
      '#opsec-restore-btn{background:none;border:none;color:#a89c88;cursor:pointer;',
        'font-size:0.62rem;font-family:"Public Sans",sans-serif;text-decoration:underline;padding:0;}',
      '#opsec-restore-btn:hover{color:#F9F8F4;}',
    ].join('');
    document.head.appendChild(style);

    var el = document.createElement('div');
    el.id = 'opsec-pw';
    el.innerHTML = '<div id="opsec-pw-bg"></div>'
      + '<div id="opsec-pw-box">'
      +   '<div class="pw-eyebrow">Restricted Access</div>'
      +   '<div class="pw-seal"><img src="/IMAGES/opsec2.png" alt="" width="72" height="72"></div>'
      +   '<div class="pw-title">OPSEC Gauntlet</div>'
      +   '<p class="pw-lede">Sixteen critical infrastructure sector chiefs. Eight evaluation dimensions. Math-driven scoring. Radical honesty.</p>'
      +   '<div class="pw-price"><span class="pw-amount">$19.99</span><span class="pw-period">/ month</span></div>'
      +   '<p class="pw-detail">Cancel anytime. Unlimited runs. Full Chamber access.</p>'
      +   '<button id="opsec-pw-btn">Subscribe to Enter</button>'
      +   '<div id="opsec-pw-err"></div>'
      +   '<div class="pw-restore-row">Already subscribed? <button id="opsec-restore-btn">Restore access</button></div>'
      + '</div>';
    document.body.appendChild(el);

    document.getElementById('opsec-pw-btn').addEventListener('click', function() {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Connecting...';
      document.getElementById('opsec-pw-err').style.display = 'none';
      fetch('/.netlify/functions/opsec-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.url) { window.location.href = d.url; return; }
          throw new Error(d.error || 'error');
        })
        .catch(function() {
          btn.disabled = false;
          btn.textContent = 'Subscribe to Enter';
          var e = document.getElementById('opsec-pw-err');
          e.textContent = 'Could not reach payment system. Try again.';
          e.style.display = 'block';
        });
    });

    document.getElementById('opsec-restore-btn').addEventListener('click', function() {
      var id = (prompt('Enter your Stripe subscription ID (starts with sub_):') || '').trim();
      if (!id || !id.startsWith('sub_')) return;
      fetch('/.netlify/functions/opsec-access-verify?subscription_id=' + encodeURIComponent(id))
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) {
            setStored({ sub: id, exp: Date.now() + ACCESS_TTL });
            location.reload();
          } else {
            alert('Subscription not found or inactive (status: ' + (d.status || d.reason || 'unknown') + ').');
          }
        })
        .catch(function() { alert('Could not verify. Check your connection and try again.'); });
    });
  }

  (async function init() {
    var params = new URLSearchParams(window.location.search);

    // Dev bypass
    if (isDevMode(params)) {
      if (params.get('dev') === DEV_VALUE) {
        storeDevMode();
        cleanUrl();
      }
      return;
    }

    // Return from Stripe checkout
    if (params.get('subscribed') === '1' && params.get('session_id')) {
      var sid = params.get('session_id');
      try {
        var r = await fetch('/.netlify/functions/opsec-access-verify?session_id=' + encodeURIComponent(sid));
        var d = await r.json();
        if (d.ok) {
          setStored({ sub: d.subscription_id, cid: d.customer_id, exp: Date.now() + ACCESS_TTL });
          cleanUrl();
          return;
        }
      } catch(_) {}
      // Verify failed
      if (isLanding) { showModal(); } else { window.location.href = '/'; }
      return;
    }

    // Check stored token
    var stored = getStored();
    if (stored && stored.exp > Date.now()) {
      // Re-verify if close to expiry
      if (stored.sub && (stored.exp - Date.now()) < RENEW_WIN) {
        try {
          var rv = await fetch('/.netlify/functions/opsec-access-verify?subscription_id=' + encodeURIComponent(stored.sub));
          var dv = await rv.json();
          if (!dv.ok) { clearStored(); if (isLanding) { showModal(); } else { window.location.href = '/'; } return; }
          stored.exp = Date.now() + ACCESS_TTL;
          setStored(stored);
        } catch(_) {} // network error: benefit of doubt
      }
      return;
    }

    // No valid token
    if (isLanding) {
      showModal();
    } else {
      window.location.href = '/';
    }
  })();
})();
