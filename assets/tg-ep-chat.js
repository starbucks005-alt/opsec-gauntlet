/* ─────────────────────────────────────────────────────────────────────────────
   tg-ep-chat.js — client side of an EP's interactive office.

   Loaded by Helpers/jules-rewrite.html (and future Helpers/<ep>.html pages
   when EE.2+ extends to other EPs). Wires the conversation, proposed
   revisions, accept/reject UI, and the revision log.

   The page provides the markup. This script discovers it by data attribute:

     [data-tg-office="ep"]        - EP id (e.g. "jules") on the root
     [data-tg-office="brief"]     - container where the current brief renders
     [data-tg-office="chat"]      - chat thread container
     [data-tg-office="input"]     - <textarea> for the user's message
     [data-tg-office="send"]      - send button

   SessionStorage shape:
     tg_visitor_brief           - current draft (mutated when revisions are accepted)
     tg_visitor_brief_orig      - frozen original (set on first load if missing)
     tg_visitor_name            - visitor first name (used in vocative)
     tg_ep_conversation_<ep>    - JSON array of chat turns
     tg_ep_revisions            - JSON array of revision log entries

   Conversation turn shape (local):
     { role: 'user' | 'assistant',
       content: string,
       proposed_revision?: {...},   // assistant turns only
       revision_status?: 'pending' | 'accepted' | 'rejected',
       ts: number }
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const ENDPOINT      = '/.netlify/functions/tg-ep-chat';
  const KEY_BRIEF     = 'tg_visitor_brief';
  const KEY_BRIEF_ORIG= 'tg_visitor_brief_orig';
  const KEY_NAME      = 'tg_visitor_name';
  const KEY_REVISIONS = 'tg_ep_revisions';
  const conversationKey = (epId) => 'tg_ep_conversation_' + epId;

  // ── sessionStorage helpers ─────────────────────────────────────────────
  function ss(k){ try { return sessionStorage.getItem(k); } catch(_) { return null; } }
  function ssSet(k, v){ try { sessionStorage.setItem(k, v); } catch(_) {} }
  function ssJson(k, fallback){
    const raw = ss(k);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch(_) { return fallback; }
  }

  function escapeHtml(s){
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  function init() {
    const root = document.querySelector('[data-tg-office="ep"]');
    if (!root) return;   // not an office page

    const epId   = root.dataset.tgOfficeEpId || 'jules';
    const briefEl = document.querySelector('[data-tg-office="brief"]');
    const chatEl  = document.querySelector('[data-tg-office="chat"]');
    const inputEl = document.querySelector('[data-tg-office="input"]');
    const sendEl  = document.querySelector('[data-tg-office="send"]');
    if (!briefEl || !chatEl || !inputEl || !sendEl) {
      console.warn('[tg-ep-chat] missing office DOM nodes');
      return;
    }

    // Freeze the original brief on first office entry. Used later by the
    // export slice to show before/after to the visitor.
    if (!ss(KEY_BRIEF_ORIG)) {
      const current = ss(KEY_BRIEF) || '';
      if (current) ssSet(KEY_BRIEF_ORIG, current);
    }

    const state = {
      epId:          epId,
      // The page provides a display name via data-tg-office-ep-name. Used
      // as the "who" label on assistant turns ("Jules" / "Ms. Ivy" / etc.).
      // Falls back to the ep_id with underscores stripped if not provided.
      epDisplayName: root.dataset.tgOfficeEpName || epId.replace(/_/g, ' '),
      name:          (ss(KEY_NAME) || '').trim(),
      brief:         (ss(KEY_BRIEF) || '').trim(),
      conversation:  ssJson(conversationKey(epId), []),
      sending:       false,
    };

    function renderBrief() {
      // Render the brief as preformatted text inside a styled container.
      // No markdown parsing - we want to show the user exactly what they
      // typed/uploaded. Whitespace preserved.
      briefEl.textContent = state.brief || '(No brief in session. Open the welcome modal from the homepage and paste your idea, then come back here.)';
      briefEl.dataset.empty = state.brief ? 'false' : 'true';
    }

    function renderChat() {
      if (state.conversation.length === 0) {
        chatEl.innerHTML = '<div class="tg-chat-empty">Open with whatever you want to work on, or just say hi - Jules will read your brief and respond.</div>';
        return;
      }
      const html = state.conversation.map((turn, idx) => renderTurn(turn, idx)).join('');
      chatEl.innerHTML = html;
      // Bind revision buttons after render.
      chatEl.querySelectorAll('[data-tg-rev-action]').forEach(btn => {
        btn.addEventListener('click', () => handleRevisionAction(
          parseInt(btn.dataset.tgRevIdx, 10),
          btn.dataset.tgRevAction
        ));
      });
      // Scroll to bottom so the newest turn is visible.
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    function renderTurn(turn, idx) {
      if (turn.role === 'user') {
        return `
          <div class="tg-chat-turn tg-chat-user">
            <div class="tg-chat-content">${escapeHtml(turn.content)}</div>
          </div>
        `;
      }
      // Assistant turn.
      let revisionHtml = '';
      if (turn.proposed_revision) {
        const r = turn.proposed_revision;
        const operation = r.operation || 'replace';
        const status = turn.revision_status || 'pending';
        const verb  = operation === 'append' ? 'addition' : 'rewrite';
        const head  = operation === 'append' ? 'Proposed addition' : 'Proposed rewrite';
        if (status === 'pending') {
          // Append: only show the new content. Replace: show before -> after.
          const diffHtml = (operation === 'append')
            ? `<div class="tg-chat-rev-after">${escapeHtml(r.after)}</div>`
            : `
              <div class="tg-chat-rev-before">${escapeHtml(r.before)}</div>
              <div class="tg-chat-rev-arrow">becomes</div>
              <div class="tg-chat-rev-after">${escapeHtml(r.after)}</div>
            `;
          revisionHtml = `
            <div class="tg-chat-revision" data-op="${escapeHtml(operation)}">
              <div class="tg-chat-rev-head">${head}: <strong>${escapeHtml(r.section_label)}</strong></div>
              <div class="tg-chat-rev-rationale">${escapeHtml(r.rationale)}</div>
              <div class="tg-chat-rev-diff">${diffHtml}</div>
              <div class="tg-chat-rev-actions">
                <button class="tg-chat-rev-btn tg-chat-rev-accept" data-tg-rev-action="accept" data-tg-rev-idx="${idx}">Accept ${verb}</button>
                <button class="tg-chat-rev-btn tg-chat-rev-reject" data-tg-rev-action="reject" data-tg-rev-idx="${idx}">Reject</button>
              </div>
            </div>
          `;
        } else if (status === 'accepted') {
          revisionHtml = `
            <div class="tg-chat-revision is-accepted">
              <div class="tg-chat-rev-head">Accepted: <strong>${escapeHtml(r.section_label)}</strong></div>
            </div>
          `;
        } else if (status === 'rejected') {
          revisionHtml = `
            <div class="tg-chat-revision is-rejected">
              <div class="tg-chat-rev-head">Rejected: <strong>${escapeHtml(r.section_label)}</strong></div>
            </div>
          `;
        }
      }
      const whoLabel = (state.epDisplayName || 'EP');
      return `
        <div class="tg-chat-turn tg-chat-assistant">
          <div class="tg-chat-who">${escapeHtml(whoLabel)}</div>
          <div class="tg-chat-content">${escapeHtml(turn.content)}</div>
          ${revisionHtml}
        </div>
      `;
    }

    function pushTurn(turn) {
      turn.ts = Date.now();
      state.conversation.push(turn);
      ssSet(conversationKey(state.epId), JSON.stringify(state.conversation));
    }

    function saveConversation() {
      ssSet(conversationKey(state.epId), JSON.stringify(state.conversation));
    }

    function setSending(on) {
      state.sending = !!on;
      sendEl.disabled = !!on;
      inputEl.disabled = !!on;
      sendEl.textContent = on ? 'Sending...' : 'Send';
    }

    async function sendMessage(text) {
      if (state.sending) return;
      const userMsg = String(text || '').trim();
      if (!userMsg && state.conversation.length > 0) return;

      // Add user turn to local state immediately for responsiveness.
      if (userMsg) {
        pushTurn({ role: 'user', content: userMsg });
        renderChat();
      }
      inputEl.value = '';
      setSending(true);

      // Build the conversation array to send: strip local-only fields.
      const wireConvo = state.conversation
        .filter(t => t.role === 'user' || t.role === 'assistant')
        .map(t => ({ role: t.role, content: String(t.content || '').slice(0, 3000) }))
        .slice(0, -1);   // strip the message we just added - it goes in user_message
                          // BUT: only if userMsg was set. Re-think below.

      // Cleaner: send the full convo MINUS the new user message, and pass
      // userMsg separately. If there was no userMsg (opening turn), the
      // function uses the synthetic kickoff.
      const conversationToSend = userMsg
        ? state.conversation.slice(0, -1).map(t => ({ role: t.role, content: String(t.content || '').slice(0, 3000) }))
        : state.conversation.map(t => ({ role: t.role, content: String(t.content || '').slice(0, 3000) }));

      let resp, data;
      try {
        resp = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ep_id:        state.epId,
            brief:        state.brief,
            name:         state.name,
            user_message: userMsg,
            conversation: conversationToSend,
          }),
        });
        data = await resp.json().catch(() => ({}));
      } catch (err) {
        pushTurn({
          role: 'assistant',
          content: 'Something interrupted that. Try again in a moment.',
        });
        renderChat();
        setSending(false);
        return;
      }

      if (!resp.ok) {
        pushTurn({
          role: 'assistant',
          content: (data && data.error) || ('Error ' + resp.status + '. Try again.'),
        });
        renderChat();
        setSending(false);
        return;
      }

      // Assistant turn.
      const turn = {
        role: 'assistant',
        content: String(data.message || '').trim(),
      };
      if (data.proposed_revision) {
        turn.proposed_revision = data.proposed_revision;
        turn.revision_status = 'pending';
      }
      pushTurn(turn);
      renderChat();
      setSending(false);
    }

    function handleRevisionAction(idx, action) {
      const turn = state.conversation[idx];
      if (!turn || !turn.proposed_revision) return;
      if (turn.revision_status && turn.revision_status !== 'pending') return;

      if (action === 'accept') {
        const r = turn.proposed_revision;
        const operation = r.operation || 'replace';

        if (operation === 'replace') {
          // Apply to brief - exact string replace. The function already
          // validated that "before" appears in the brief, but the brief
          // may have changed since (multiple accepts), so check again.
          if (!state.brief.includes(r.before)) {
            turn.revision_status = 'rejected';
            state.conversation.push({
              role: 'assistant',
              content: 'I went to apply that and the text I was working from is no longer in your brief - probably an earlier accept changed it. Point me at the current version and I will redo it.',
              ts: Date.now(),
            });
            saveConversation();
            renderChat();
            return;
          }
          state.brief = state.brief.replace(r.before, r.after);
        } else if (operation === 'append') {
          // Append the new content with a two-line break separator. If
          // the brief already ends with whitespace, normalize first so
          // we do not end up with five blank lines.
          const trimmed = state.brief.replace(/\s+$/, '');
          state.brief = trimmed + '\n\n' + r.after;
        } else {
          // Unknown operation - bail out, do not mutate.
          console.warn('[tg-ep-chat] unknown revision operation', operation);
          return;
        }

        ssSet(KEY_BRIEF, state.brief);
        turn.revision_status = 'accepted';

        // Append to revision log.
        const revisions = ssJson(KEY_REVISIONS, []);
        revisions.push({
          ep_id:         state.epId,
          operation:     operation,
          section_label: r.section_label,
          before:        r.before || '',
          after:         r.after,
          rationale:     r.rationale,
          accepted_at:   Date.now(),
        });
        ssSet(KEY_REVISIONS, JSON.stringify(revisions));

        saveConversation();
        renderBrief();
        renderChat();
      } else if (action === 'reject') {
        turn.revision_status = 'rejected';
        saveConversation();
        renderChat();
      }
    }

    // Wire input.
    sendEl.addEventListener('click', () => sendMessage(inputEl.value));
    inputEl.addEventListener('keydown', (e) => {
      // Enter sends. Shift + Enter keeps newlines for multi-line drafts.
      // Cmd/Ctrl + Enter still sends (legacy muscle memory from earlier UX).
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
        e.preventDefault();
        sendMessage(inputEl.value);
      }
    });

    // Initial render. If no conversation, fire the opening greeting.
    renderBrief();
    renderChat();
    if (state.conversation.length === 0 && state.brief) {
      sendMessage('');   // empty user_message triggers Jules's opening
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
