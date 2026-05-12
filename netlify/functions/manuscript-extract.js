/* ─────────────────────────────────────────────────────────────────────────────
   netlify/functions/manuscript-extract.js
   Public (no auth) — extracts text + metadata from a manuscript PDF.

   POST body : { pdfBase64: string, filename?: string }
   Response  : { text: string, wordCount: number, metadata: {
                   title, genre, protagonist, antagonist,
                   setting, conflict, chapterCount } }
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const pdfjsLib  = require('pdfjs-dist/legacy/build/pdf.js');

pdfjsLib.GlobalWorkerOptions.workerSrc = false;

const MODEL    = 'claude-sonnet-4-6';
const TEXT_CAP = 600000; // chars stored in client — covers a ~110k-word novel with headroom

async function extractText(buf) {
  const data = new Uint8Array(buf);
  const loadingTask = pdfjsLib.getDocument({
    data,
    useWorkerFetch:  false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;

  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page    = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    let lastY   = null;
    let pageBuf = '';
    for (const item of content.items) {
      if (!item.str) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        fullText += pageBuf.trimEnd() + '\n';
        pageBuf = '';
      }
      pageBuf += item.str;
      lastY = y;
    }
    if (pageBuf.trim()) fullText += pageBuf.trimEnd() + '\n';
    fullText += '\n';
  }
  return fullText;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { pdfBase64 } = body || {};
  if (!pdfBase64) return { statusCode: 400, body: JSON.stringify({ error: 'pdfBase64 required' }) };

  /* ── Step 1: text extraction via pdfjs-dist (preserves line breaks) ───────── */
  let text = '';
  let wordCount = 0;
  try {
    const buf = Buffer.from(pdfBase64, 'base64');
    text      = await extractText(buf);
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
