/* ─────────────────────────────────────────────────────────────────────────────
   netlify/functions/manuscript-extract.js
   Public (no auth) — extracts text + metadata from a manuscript PDF.

   POST body : { pdfBase64: string, filename?: string }
   Response  : { text: string, wordCount: number, metadata: {
                   title, genre, protagonist, antagonist,
                   setting, conflict, chapterCount } }
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const pdfParse  = require('pdf-parse/lib/pdf-parse.js');

const MODEL   = 'claude-sonnet-4-6';
const TEXT_CAP = 150000; // chars stored in client

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { pdfBase64, filename } = body || {};
  if (!pdfBase64) return { statusCode: 400, body: JSON.stringify({ error: 'pdfBase64 required' }) };

  /* ── Step 1: text extraction via pdf-parse ────────────────────────────────── */
  let text = '';
  let wordCount = 0;
  try {
    const buf = Buffer.from(pdfBase64, 'base64');
    const parsed = await pdfParse(buf);
    text      = parsed.text || '';
    wordCount = text.split(/\s+/).filter(Boolean).length;
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'PDF parse error: ' + e.message }) };
  }

  /* ── Step 2: metadata extraction via Claude ───────────────────────────────── */
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const excerpt = text.slice(0, 14000); // enough for reliable metadata

  let metadata = {};
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are analyzing the opening of a manuscript. Return ONLY a valid JSON object — no markdown, no explanation:

---
${excerpt}
---

{
  "title": "the book title or empty string if not found",
  "genre": "one of: literary | thriller | mystery | scifi | historical | romance | other",
  "protagonist": "protagonist name and one-sentence description",
  "antagonist": "antagonist or antagonistic force, one sentence, or empty string",
  "setting": "time and place — e.g. Vienna 1938 or near-future Detroit",
  "conflict": "one or two sentences on the central conflict and theme",
  "chapterCount": estimated total chapter count as integer
}`,
      }],
    });

    const raw   = resp.content[0].text.trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    metadata = JSON.parse(clean);
  } catch (e) {
    // metadata extraction failed — still return text so store works
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      text:      text.slice(0, TEXT_CAP),
      wordCount,
      metadata,
    }),
  };
};
