/* ─────────────────────────────────────────────────────────────────────────────
   tg-export-docx — produce a DOCX of the visitor's current brief plus the
   revision log (what each EP changed during the session).

   The visitor uploaded a brief (or pasted one in the welcome modal). They
   walked into one or more EP offices. Each accepted revision (replace or
   append) was logged to sessionStorage on the client. When they hit
   "Export brief," the client posts the current brief, the frozen
   original, and the revision array here. We produce a DOCX with:

     - Cover block (name, title, export timestamp)
     - Current brief
     - Revision history (each revision: EP, section, rationale, before / after, accepted-at)
     - Original brief (frozen at upload, before any EP touched it)

   The structured revision log is the audit trail Terry asked for: anyone
   reading the document can see exactly which sections were AI-touched
   and which still read like the founder.

   POST body : {
     brief:        string (required) - current draft text, with accepted edits applied
     original:     string (optional) - frozen original brief, pre-edits
     revisions:    array  (optional) - revision log entries:
                     { ep_id, ep_name?, operation, section_label, before, after, rationale, accepted_at }
     name:         string (optional) - visitor first name for the cover
     title:        string (optional) - submission title for the cover
   }
   Response  : 200 application/octet-stream  (the .docx bytes)
               400 - bad input
               500 - docx library failure

   Env vars  : none. Pure transform, no AI, no DB.
   ───────────────────────────────────────────────────────────────────────────── */

const docx = require('docx');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak } = docx;

const BRIEF_MAX     = 20000;
const REVISION_MAX  = 200;
const TEXT_FIELD_MAX = 4000;
const NAME_MAX      = 60;
const TITLE_MAX     = 200;

const KNOWN_EP_NAMES = {
  jules:          'Jules',
  ms_ivy:         'Ms. Ivy',
  wren_calloway:  'Wren Calloway',
  carol_haynes:   'Carol Haynes',
  matthew_vance:  'Matthew Vance',
  arjun_mehta:    'Arjun Mehta',
  zara_cole:      'Zara Cole',
  reid_callum:    'Reid Callum',
  grant_ellis:    'Grant Ellis',
};

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ error: message }),
  };
}

// Helpers for paragraph styling.
function H1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 480, after: 240 },
    children: [new TextRun({ text, bold: true, size: 36 })],
  });
}
function H2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 360, after: 180 },
    children: [new TextRun({ text, bold: true, size: 28 })],
  });
}
function H3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, size: 24 })],
  });
}
function P(text, opts) {
  opts = opts || {};
  return new Paragraph({
    spacing: { before: 80, after: 120, line: 320 },
    children: [new TextRun({ text: String(text || ''), italics: !!opts.italic, color: opts.color || '000000', size: 22 })],
  });
}
function PSmall(text) {
  return new Paragraph({
    spacing: { before: 40, after: 80 },
    children: [new TextRun({ text: String(text || ''), color: '6B6B6B', size: 18 })],
  });
}
function Quoted(text) {
  // Block quote style: indented, italic, gray
  return new Paragraph({
    spacing: { before: 80, after: 120, line: 300 },
    indent: { left: 360 },
    children: [new TextRun({ text: String(text || ''), italics: true, color: '4A4A4A', size: 21 })],
  });
}
function Divider() {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    border: { bottom: { style: 'single', size: 6, color: 'CCCCCC' } },
    children: [],
  });
}

// Break a multi-line block of text into separate Paragraphs, preserving
// blank lines as inter-paragraph spacing. The body of the brief and the
// before/after revision blocks both run through this.
function paragraphsFromText(text, opts) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trimEnd();
  if (!raw) return [P('(empty)', { italic: true, color: '7D735F' })];
  return raw.split(/\n+/).map(line => P(line, opts));
}

function epDisplayName(epId, suggested) {
  const known = KNOWN_EP_NAMES[String(epId || '').trim()];
  if (known) return known;
  if (suggested && typeof suggested === 'string') return suggested.trim();
  return String(epId || 'EP').replace(/_/g, ' ');
}

function fmtTimestamp(ms) {
  if (!ms) return '';
  try {
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '';
    return d.toUTCString();
  } catch (_) { return ''; }
}

function buildDocument(payload) {
  const name      = String(payload.name  || '').trim().slice(0, NAME_MAX);
  const title     = String(payload.title || '').trim().slice(0, TITLE_MAX) || 'Untitled brief';
  const brief     = String(payload.brief || '').slice(0, BRIEF_MAX);
  const original  = String(payload.original || '').slice(0, BRIEF_MAX);
  const revisions = Array.isArray(payload.revisions) ? payload.revisions.slice(0, REVISION_MAX) : [];

  const exportedAt = new Date().toUTCString();

  const children = [];

  // ── Cover ────────────────────────────────────────────────────────────
  children.push(new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [new TextRun({ text: 'THE GAUNTLET', bold: true, size: 18, color: 'B8922A' })],
  }));
  children.push(new Paragraph({
    spacing: { after: 240 },
    children: [new TextRun({ text: 'BRIEF EXPORT', color: '6B6B6B', size: 16 })],
  }));
  children.push(H1(title));
  if (name) children.push(P('Prepared by ' + name, { color: '4A4A4A' }));
  children.push(PSmall('Exported: ' + exportedAt));
  children.push(PSmall('Revisions logged: ' + revisions.length));
  children.push(Divider());

  // ── Current brief ────────────────────────────────────────────────────
  children.push(H2('Current brief'));
  if (revisions.length) {
    children.push(P(
      'This is the working draft after ' + revisions.length + ' accepted ' +
      (revisions.length === 1 ? 'revision' : 'revisions') +
      ' from The Gauntlet Executive Producers. The full revision log is below. The original brief, as uploaded before any EP touched it, is at the end of this document.',
      { italic: true, color: '6B6B6B' }
    ));
  } else {
    children.push(P(
      'This is the working draft. No revisions have been accepted from the Executive Producers; this is the brief exactly as the visitor submitted it.',
      { italic: true, color: '6B6B6B' }
    ));
  }
  paragraphsFromText(brief).forEach(p => children.push(p));

  // ── Revision history ─────────────────────────────────────────────────
  if (revisions.length) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(H2('Revision history'));
    children.push(P(
      'Each entry below is a section of the brief that an Executive Producer rewrote (replace) or expanded with new context (append), and that the visitor accepted. Read this as the audit trail of what was AI-touched and what still reads like the founder.',
      { italic: true, color: '6B6B6B' }
    ));

    revisions.forEach((rev, idx) => {
      const op = String(rev.operation || 'replace').toLowerCase();
      const sectionLabel = String(rev.section_label || '').slice(0, 200) || 'Unnamed section';
      const epName       = epDisplayName(rev.ep_id, rev.ep_name);
      const acceptedAt   = fmtTimestamp(rev.accepted_at);

      children.push(H3((idx + 1) + '. ' + epName + ' — ' + sectionLabel));
      const opLabel = op === 'append' ? 'Append (new section)' : 'Replace (section rewritten)';
      children.push(PSmall('Operation: ' + opLabel + (acceptedAt ? '   ·   Accepted ' + acceptedAt : '')));

      if (rev.rationale) {
        children.push(P('Rationale', { color: '6B6B6B' }));
        children.push(Quoted(String(rev.rationale).slice(0, TEXT_FIELD_MAX)));
      }

      if (op === 'replace') {
        const before = String(rev.before || '').slice(0, TEXT_FIELD_MAX);
        const after  = String(rev.after  || '').slice(0, TEXT_FIELD_MAX);
        if (before) {
          children.push(P('Before', { color: '6B6B6B' }));
          paragraphsFromText(before, { color: '7D735F', italic: true }).forEach(p => children.push(p));
        }
        if (after) {
          children.push(P('After', { color: '6B6B6B' }));
          paragraphsFromText(after).forEach(p => children.push(p));
        }
      } else {
        // append
        const after = String(rev.after || '').slice(0, TEXT_FIELD_MAX);
        children.push(P('Appended', { color: '6B6B6B' }));
        paragraphsFromText(after).forEach(p => children.push(p));
      }

      children.push(Divider());
    });
  }

  // ── Original brief ───────────────────────────────────────────────────
  if (original && original.trim() && original.trim() !== brief.trim()) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(H2('Original brief (pre-edits)'));
    children.push(P(
      'This is the brief exactly as the visitor uploaded or pasted it, before any Executive Producer revisions were applied. Use this as the reference for what was originally written.',
      { italic: true, color: '6B6B6B' }
    ));
    paragraphsFromText(original).forEach(p => children.push(p));
  }

  return new Document({
    creator:     'The Gauntlet',
    title:       title,
    description: 'Brief export with revision log',
    sections: [{
      properties: { page: { margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } },
      children:   children,
    }],
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }
  if (event.httpMethod !== 'POST') return jsonError(405, 'method not allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonError(400, 'invalid json'); }

  const brief = String(body.brief || '').trim();
  if (!brief) return jsonError(400, 'brief is required');

  let doc;
  try {
    doc = buildDocument(body);
  } catch (err) {
    console.error('[tg-export-docx] build failed', err && err.message);
    return jsonError(500, 'document construction failed');
  }

  let buf;
  try {
    buf = await Packer.toBuffer(doc);
  } catch (err) {
    console.error('[tg-export-docx] pack failed', err && err.message);
    return jsonError(500, 'document pack failed');
  }

  // Sanitize the filename: visitor name + title, alphanumeric + dash only.
  const safeName  = String(body.name  || 'gauntlet').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'gauntlet';
  const safeTitle = String(body.title || 'brief').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brief';
  const filename  = `${safeName}-${safeTitle}.docx`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(buf.length),
      'Cache-Control':       'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};
