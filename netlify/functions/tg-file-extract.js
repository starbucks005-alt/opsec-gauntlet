/* ─────────────────────────────────────────────────────────────────────────────
   tg-file-extract — extract plain text from an uploaded PDF, DOCX, or TXT.

   The visitor's brief sometimes lives in a document. They drop the file in
   on intake.html; the file is base64-encoded client-side and POSTed to
   this function; we sniff the type, extract the text, and return it.
   intake.html drops the extracted text into the description field where
   the visitor can edit it before submitting.

   POST body : {
     filename: string (required, 1-200 chars) - so we can sniff by extension
     mime:     string (optional)              - secondary type hint
     data:     string (required)              - base64-encoded file bytes
   }
   Response  : 200 { text, filename, originalLength, truncated }
               400 { error } - missing fields or bad base64
               413 { error } - file exceeds size cap
               415 { error } - unsupported file type
               422 { error } - extracted text was empty OR violates conduct
               502 { error } - extraction failed

   Limits    : 5.5 MB base64 body (~4 MB binary)
               12,000 chars of extracted text returned (the visible cap on
               the intake description field). Original length reported so
               the front end can warn "truncated."

   Env vars  : none. Pure extraction, no AI / no DB.
   ───────────────────────────────────────────────────────────────────────────── */

const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');

const MAX_BASE64_BYTES = 5_500_000;   // ~4 MB binary after decode
const MAX_TEXT_LEN     = 12000;       // matches intake description maxlength
const FILENAME_MAX     = 200;

// Mirrors the word list in assets/tg-chamber-rules.js. Keep in sync. If
// this drifts we lose the defense-in-depth promise. Future: extract to a
// shared config file.
const PROFANITY = [
  'fuck', 'fucks', 'fucked', 'fucking', 'fucker', 'fuckers', 'fuckin',
  'shit', 'shits', 'shitty', 'bullshit',
  'bitch', 'bitches', 'bitching', 'bitchy',
  'cunt', 'cunts',
  'bastard', 'bastards',
  'piss', 'pissed', 'pissing',
  'cock', 'cocks',
  'dick', 'dicks', 'dickhead',
  'asshole', 'assholes',
  'ass', 'asses',
  'faggot', 'faggots', 'fag', 'fags',
  'nigger', 'niggers', 'nigga', 'niggas',
  'retard', 'retards', 'retarded',
  'tranny', 'trannies',
];

function containsProfanity(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  for (let i = 0; i < PROFANITY.length; i++) {
    const re = new RegExp('\\b' + PROFANITY[i] + '\\b');
    if (re.test(lower)) return true;
  }
  return false;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

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
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const filename = String(body.filename || '').trim().slice(0, FILENAME_MAX);
  const mime     = String(body.mime     || '').trim().toLowerCase();
  const data     = String(body.data     || '');

  if (!filename) return json(400, { error: 'filename is required' });
  if (!data)     return json(400, { error: 'data is required' });
  if (data.length > MAX_BASE64_BYTES) {
    return json(413, { error: 'file too large (max ~4 MB)' });
  }

  let buf;
  try { buf = Buffer.from(data, 'base64'); }
  catch { return json(400, { error: 'data is not valid base64' }); }
  if (buf.length === 0) return json(400, { error: 'data decoded to empty buffer' });

  // Type sniffing: extension first (most reliable for our three), mime as
  // fallback. We do not trust mime alone because browsers sometimes report
  // application/octet-stream for known types.
  const ext = (filename.split('.').pop() || '').toLowerCase();

  let text = '';
  try {
    if (ext === 'pdf' || mime === 'application/pdf') {
      const result = await pdfParse(buf);
      text = result && result.text ? result.text : '';
    } else if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result && result.value ? result.value : '';
    } else if (ext === 'txt' || mime === 'text/plain') {
      text = buf.toString('utf-8');
    } else {
      return json(415, { error: 'unsupported file type. Use PDF, DOCX, or TXT.' });
    }
  } catch (err) {
    console.error('[tg-file-extract] extraction error', err && err.message);
    return json(502, { error: 'could not read the file' });
  }

  // Normalize whitespace. Trim. Collapse runs of blank lines to two.
  text = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return json(422, { error: 'no text found in file' });

  const originalLength = text.length;
  let truncated = false;
  if (text.length > MAX_TEXT_LEN) {
    text = text.slice(0, MAX_TEXT_LEN);
    truncated = true;
  }

  // Defense in depth: the intake form will profanity-check the description
  // field on submit, so this would catch the same string twice. This layer
  // matters when someone hits the API directly (bypassing intake.html).
  if (containsProfanity(text)) {
    return json(422, {
      error: 'extracted text contains language that violates The Chamber\'s conduct rules',
      code: 'conduct',
    });
  }

  return json(200, {
    text,
    filename,
    originalLength,
    truncated,
  });
};
