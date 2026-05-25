/* ─────────────────────────────────────────────────────────────────────────────
   tg-matthew-tools.js — Buyer Psychology Profile generator for Matthew's
   office. Mirrors the tg-reid-tools.js / tg-arjun-tools.js pattern.

   Renders the psychology profile with: primary driver chip, secondary
   driver chips, the specific trigger-moment scene, the identity framing,
   applied frameworks, and CROSS-EP REFERRAL cards that link back to the
   other EP offices (Reid, Zara, Jules, Grant, Arjun, Carol, Wren, Ivy).

   SessionStorage:
     tg_visitor_brief    - mutated when the profile returns
     tg_visitor_name     - greeting
     tg_ep_revisions     - revision log (profile appended)
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const FETCH_TIMEOUT_MS = 40000;

  // Map of EP id -> office page URL for the cross-referral chips.
  // Keep in sync with the Helpers/ directory.
  const EP_OFFICES = {
    reid_callum:   '/Helpers/reid-marketing.html',
    zara_cole:     '/Helpers/zara-influencer.html',
    jules:         '/Helpers/jules-rewrite.html',
    grant_ellis:   '/Helpers/grant-coach.html',
    arjun_mehta:   '/Helpers/arjun-delivery.html',
    carol_haynes:  '/Helpers/carol-screener.html',
    wren_calloway: '/Helpers/wren-scout.html',
    ms_ivy:        '/Helpers/ivy-librarian.html',
  };

  const TOOLS = {
    psych: {
      endpoint:       '/.netlify/functions/tg-matthew-psych',
      brieflabel:     'Buyer Psychology Profile',
      bodyForFetch:   () => ({}),
      render:         renderPsych,
      formatForBrief: formatPsychForBrief,
    },
  };

  function ss(k){ try { return sessionStorage.getItem(k); } catch(_) { return null; } }
  function ssSet(k, v){ try { sessionStorage.setItem(k, v); } catch(_){} }
  function ssJson(k, fallback){
    const raw = ss(k);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch(_) { return fallback; }
  }

  function escapeHtml(s){
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function rerenderBriefPanel() {
    const briefEl = document.querySelector('[data-tg-office="brief"]');
    if (!briefEl) return;
    const brief = ss(KEY_BRIEF) || '';
    if (brief) {
      briefEl.textContent = brief;
      briefEl.removeAttribute('data-empty');
    } else {
      briefEl.textContent = 'No brief yet. Drop something in from the welcome modal.';
      briefEl.setAttribute('data-empty', 'true');
    }
  }

  function appendToBrief(plainText, meta) {
    const oldBrief = (ss(KEY_BRIEF) || '').trim();
    const header   = `[${meta.brieflabel}] ${meta.title || ''}`.trim();
    const block    = header + '\n\n' + plainText.trim();
    const newBrief = oldBrief ? (oldBrief + '\n\n' + block) : block;
    ssSet(KEY_BRIEF, newBrief);

    const revisions = ssJson(KEY_REVISIONS, []);
    revisions.push({
      ep_id:         'matthew_vance',
      operation:     'append',
      section_label: meta.title ? `${meta.brieflabel}: ${String(meta.title).slice(0, 80)}` : meta.brieflabel,
      before:        '',
      after:         block,
      rationale:     meta.rationale || `${meta.brieflabel} drafted by Matthew.`,
      accepted_at:   Date.now(),
    });
    ssSet(KEY_REVISIONS, JSON.stringify(revisions));

    rerenderBriefPanel();
  }

  // ── Renderer ─────────────────────────────────────────────────────────
  function renderPsych(data) {
    const primary    = data.primary_driver || {};
    const secondary  = Array.isArray(data.secondary_drivers)   ? data.secondary_drivers   : [];
    const trigger    = String(data.trigger_moment   || '');
    const identity   = String(data.identity_framing || '');
    const frameworks = Array.isArray(data.frameworks_applied)  ? data.frameworks_applied  : [];
    const referrals  = Array.isArray(data.cross_ep_referrals)  ? data.cross_ep_referrals  : [];
    const rationale  = String(data.rationale || '');

    const primaryHtml = primary && primary.driver
      ? '<div class="mt-driver-primary">'
        + '<span class="mt-driver-chip mt-driver-primary-chip">' + escapeHtml(primary.driver) + '</span>'
        + '<p class="mt-driver-why">' + escapeHtml(primary.why || '') + '</p>'
      + '</div>'
      : '';

    const secondaryHtml = secondary.map(d => ''
      + '<div class="mt-driver-secondary">'
      +   '<span class="mt-driver-chip">' + escapeHtml(d.driver || '') + '</span>'
      +   '<p class="mt-driver-why">' + escapeHtml(d.why || '') + '</p>'
      + '</div>'
    ).join('');

    const frameworksHtml = frameworks.map(f => ''
      + '<div class="mt-framework">'
      +   '<div class="mt-framework-name">' + escapeHtml(f.framework || '') + '</div>'
      +   '<p>' + escapeHtml(f.relevance || '') + '</p>'
      + '</div>'
    ).join('');

    const referralsHtml = referrals.map(r => {
      const url = EP_OFFICES[r.ep] || '#';
      return ''
        + '<a class="mt-referral" href="' + escapeHtml(url) + '">'
        +   '<div class="mt-referral-head">'
        +     '<span class="mt-referral-ep">' + escapeHtml(r.ep_label || '') + '</span>'
        +     '<span class="mt-referral-arrow">' + '→' + '</span>'
        +   '</div>'
        +   '<p>' + escapeHtml(r.reason || '') + '</p>'
        + '</a>';
    }).join('');

    return ''
      + '<div class="rt-out-block"><div class="rt-out-label">Primary driver</div>' + primaryHtml + '</div>'
      + (secondaryHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Secondary drivers</div>'
            + '<div class="mt-secondary-list">' + secondaryHtml + '</div></div>'
          : '')
      + '<div class="rt-out-block"><div class="rt-out-label">Trigger moment</div>'
      +   '<div class="mt-scene">' + escapeHtml(trigger) + '</div></div>'
      + '<div class="rt-out-block"><div class="rt-out-label">Identity framing</div>'
      +   '<div class="mt-identity">' + escapeHtml(identity) + '</div></div>'
      + (frameworksHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Behavioral frameworks applied</div>'
            + '<div class="mt-framework-list">' + frameworksHtml + '</div></div>'
          : '')
      + (referralsHtml
          ? '<div class="rt-out-block"><div class="rt-out-label">Walk to next - psychology turns into deliverables here</div>'
            + '<div class="mt-referral-list">' + referralsHtml + '</div></div>'
          : '')
      + (rationale ? '<p class="zh-result-rationale">' + escapeHtml(rationale) + '</p>' : '');
  }

  function formatPsychForBrief(data) {
    const lines = [];
    const primary = data.primary_driver || {};
    lines.push(`PRIMARY DRIVER: ${primary.driver || ''}`);
    if (primary.why) lines.push(`  ${primary.why}`);
    lines.push('');
    if (Array.isArray(data.secondary_drivers) && data.secondary_drivers.length) {
      lines.push('SECONDARY DRIVERS');
      data.secondary_drivers.forEach(d => lines.push(`  - ${d.driver}: ${d.why || ''}`));
      lines.push('');
    }
    lines.push('TRIGGER MOMENT');
    lines.push(`  ${data.trigger_moment || ''}`);
    lines.push('');
    lines.push('IDENTITY FRAMING');
    lines.push(`  ${data.identity_framing || ''}`);
    lines.push('');
    if (Array.isArray(data.frameworks_applied) && data.frameworks_applied.length) {
      lines.push('BEHAVIORAL FRAMEWORKS APPLIED');
      data.frameworks_applied.forEach(f => lines.push(`  - ${f.framework}: ${f.relevance || ''}`));
      lines.push('');
    }
    if (Array.isArray(data.cross_ep_referrals) && data.cross_ep_referrals.length) {
      lines.push('WALK TO NEXT (cross-EP referrals)');
      data.cross_ep_referrals.forEach(r => lines.push(`  - ${r.ep_label}: ${r.reason || ''}`));
      lines.push('');
    }
    if (data.rationale) { lines.push('NOTE'); lines.push(`  ${data.rationale}`); }
    return { plainText: lines.join('\n'), title: (data.primary_driver && data.primary_driver.driver) ? `primary driver - ${data.primary_driver.driver}` : '' };
  }

  async function generate(form, toolKey) {
    const cfg = TOOLS[toolKey];
    if (!cfg) return;

    const submitBtn = form.querySelector('[data-mt="generate"]');
    const resultEl  = form.querySelector('[data-mt="result"]');

    const brief = (ss(KEY_BRIEF) || '').trim();
    if (brief.length < 30) {
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">Drop your brief in from the welcome modal first. Matthew reads the brief for emotion, not stated need.</div>';
      return;
    }
    const name = (ss(KEY_NAME) || '').trim();

    submitBtn.disabled = true;
    const origLabel = submitBtn.textContent;
    submitBtn.textContent = 'Reading...';
    resultEl.className = 'zh-result is-loading';
    resultEl.innerHTML = '<div class="zh-result-msg">Matthew is reading. About 20 seconds.</div>';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ brief, name }, cfg.bodyForFetch(form))),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(toolKey + ' ' + resp.status + ' ' + text.slice(0, 200));
      }
      const data = await resp.json();

      const formatted = cfg.formatForBrief(data);
      appendToBrief(formatted.plainText, {
        brieflabel: cfg.brieflabel,
        title:      formatted.title,
        rationale:  data.rationale,
      });

      resultEl.className = 'zh-result is-ready';
      resultEl.innerHTML = ''
        + '<div class="zh-result-meta">'
        +   '<span class="zh-result-platform">' + escapeHtml(cfg.brieflabel) + '</span>'
        + '</div>'
        + cfg.render(data)
        + '<p class="zh-result-saved">Saved to your brief and revision log. Click any "walk to next" card to step into that EP\'s office and turn the psychology into their deliverable.</p>';
    } catch (err) {
      clearTimeout(timer);
      const msg = (err && err.message) || String(err);
      const isTimeout = msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('timeout');
      console.warn('[tg-matthew-tools:' + toolKey + ']', msg);
      resultEl.className = 'zh-result is-error';
      resultEl.innerHTML = '<div class="zh-result-msg">' + (
        isTimeout
          ? 'Matthew took too long. Try again, or refresh the page.'
          : 'Could not build the profile. Try again.'
      ) + '</div>';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origLabel;
    }
  }

  function init() {
    document.querySelectorAll('[data-mt-tool]').forEach(form => {
      const toolKey = form.getAttribute('data-mt-tool');
      if (!TOOLS[toolKey]) return;
      const submitBtn = form.querySelector('[data-mt="generate"]');
      if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); generate(form, toolKey); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
