/* ─────────────────────────────────────────────────────────────────────────────
   assets/sample-pdfs.js — public-domain sample manuscripts for the GP tools

   Usage on a tool page:
     <script src="assets/sample-pdfs.js" defer></script>
     <div data-gp-samples data-target="msHandleFile"></div>

   Drop a <div data-gp-samples data-target="<window-function-name>"> anywhere
   on a page that takes a PDF upload. The script fills the div with a "Try a
   sample" picker. When a title is chosen, the matching PDF is fetched, wrapped
   in a File object, and handed to window[<target>](file).

   For pages with a more idiosyncratic flow, call gpSamples.load(slug, fn) directly:
     gpSamples.load('frankenstein', file => myCustomHandler(file));
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const SAMPLES = [
    { slug: 'pride-and-prejudice', title: 'Pride and Prejudice',                 author: 'Jane Austen',          tag: 'Romance · Literary · 1813' },
    { slug: 'sherlock-holmes',     title: 'The Adventures of Sherlock Holmes',   author: 'Arthur Conan Doyle',   tag: 'Mystery · 1892' },
    { slug: 'frankenstein',        title: 'Frankenstein',                        author: 'Mary Shelley',         tag: 'Sci-Fi · Gothic · 1818' },
    { slug: 'great-gatsby',        title: 'The Great Gatsby',                    author: 'F. Scott Fitzgerald',  tag: 'Literary · 1925' },
  ];

  // Inject a once-per-page stylesheet
  if (!document.getElementById('gp-samples-style')) {
    const style = document.createElement('style');
    style.id = 'gp-samples-style';
    style.textContent = `
      .gp-samples{margin:1rem 0 1.5rem;font-family:'DM Mono',monospace;}
      .gp-samples-label{font-size:0.6rem;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-muted,rgba(244,237,224,0.55));margin-bottom:0.5rem;}
      .gp-samples-label .gp-no-credit{color:var(--accent,#b8922a);}
      .gp-samples-row{display:flex;gap:0.5rem;flex-wrap:wrap;}
      .gp-samples-btn{font-family:'DM Mono',monospace;font-size:0.6rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent,#b8922a);background:rgba(184,146,42,0.06);border:1px solid rgba(184,146,42,0.35);padding:0.45rem 0.85rem;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:0.45rem;transition:background 0.15s,border-color 0.15s;}
      .gp-samples-btn:hover{background:rgba(184,146,42,0.18);border-color:rgba(184,146,42,0.6);}
      .gp-samples-btn[disabled]{opacity:0.5;cursor:wait;}
      .gp-samples-btn .gp-samples-tag{font-size:0.55rem;letter-spacing:0.1em;color:var(--text-muted,rgba(244,237,224,0.5));text-transform:none;}
      .gp-samples-status{font-size:0.6rem;letter-spacing:0.12em;color:var(--accent,#b8922a);min-height:1em;margin-top:0.4rem;}
    `;
    document.head.appendChild(style);
  }

  async function fetchSampleAsFile(slug) {
    const meta = SAMPLES.find(s => s.slug === slug);
    if (!meta) throw new Error('Unknown sample: ' + slug);
    const res = await fetch('/samples/' + slug + '.pdf', { cache: 'force-cache' });
    if (!res.ok) throw new Error('Could not load sample: HTTP ' + res.status);
    const blob = await res.blob();
    return new File([blob], slug + '.pdf', { type: 'application/pdf' });
  }

  function render(container) {
    const targetName = container.dataset.target;
    const inputSel = container.dataset.input;
    if (!targetName && !inputSel) {
      container.innerHTML = '<em style="color:#c0392b;font-size:0.8rem;">[gp-samples] Need data-target or data-input</em>';
      return;
    }

    container.classList.add('gp-samples');
    container.innerHTML = `
      <div class="gp-samples-label">Try a sample manuscript <span class="gp-no-credit">· no credit cost to load</span></div>
      <div class="gp-samples-row">
        ${SAMPLES.map(s =>
          `<button type="button" class="gp-samples-btn" data-slug="${s.slug}" title="${s.author} — ${s.tag}">${s.title}<span class="gp-samples-tag">${s.tag.split(' · ')[0]}</span></button>`
        ).join('')}
      </div>
      <div class="gp-samples-status" data-status></div>
    `;

    const status = container.querySelector('[data-status]');
    const inputSelector = container.dataset.input; // alternative mode: drive a <input type=file> element

    container.querySelectorAll('.gp-samples-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.slug;
        const meta = SAMPLES.find(s => s.slug === slug);
        container.querySelectorAll('.gp-samples-btn').forEach(b => b.disabled = true);
        status.textContent = 'Loading "' + meta.title + '"…';
        try {
          const file = await fetchSampleAsFile(slug);
          status.textContent = 'Loaded "' + meta.title + '". Handing to the tool…';
          if (inputSelector) {
            // Drive an existing <input type="file"> by setting .files via DataTransfer + dispatching change.
            const input = document.querySelector(inputSelector);
            if (!input) throw new Error('Input not found: ' + inputSelector);
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const handler = window[targetName];
            if (typeof handler !== 'function') throw new Error('Tool handler not ready (' + targetName + '). Try again in a moment.');
            await handler(file);
          }
          status.textContent = '';
        } catch (err) {
          status.textContent = 'Could not load sample: ' + err.message;
        } finally {
          container.querySelectorAll('.gp-samples-btn').forEach(b => b.disabled = false);
        }
      });
    });
  }

  // Public API
  window.gpSamples = {
    list: () => SAMPLES.slice(),
    load: async (slug, handler) => {
      const file = await fetchSampleAsFile(slug);
      return handler(file);
    },
  };

  // Auto-render any [data-gp-samples] elements present on DOMContentLoaded
  function init() {
    document.querySelectorAll('[data-gp-samples]').forEach(render);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
