// netlify/functions/extract-book-characters.js
// Greylander Press — Character Portraits feature
// Extracts named characters with descriptions from an uploaded book PDF (or text),
// then suggests an image-generation prompt for each one.
//
// POST body: { filename, content_base64, book_title?, book_style? }
// Returns: { book_signature, characters: [{ name, description, suggested_prompt }] }

const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse');
const https = require('https');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_BYTES = 25 * 1024 * 1024;
// Send only the first ~25K chars of the book to the LLM. Most named characters
// are introduced in the opening third; this also keeps us comfortably inside
// Netlify's 26s function timeout for full novels.
const TEXT_LIMIT = 25000;

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function callAnthropic(system, prompt, model, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.reject(new Error('ANTHROPIC_API_KEY not configured'));
  const payload = JSON.stringify({
    model: model || 'claude-sonnet-4-6',
    max_tokens: maxTokens || 4000,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) reject(new Error(p.error.message || 'Anthropic API error'));
          else resolve(p);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Authentication required' });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json(401, { error: 'Invalid session' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { filename, content_base64, book_title, book_style } = body;
  if (!filename || !content_base64) return json(400, { error: 'filename and content_base64 are required' });

  let buf;
  try { buf = Buffer.from(content_base64, 'base64'); }
  catch { return json(400, { error: 'Invalid base64' }); }
  if (!buf.length)             return json(400, { error: 'Empty file' });
  if (buf.length > MAX_BYTES)  return json(413, { error: `File exceeds ${Math.round(MAX_BYTES/1024/1024)} MB` });

  // Stable signature for this book — same upload by same user re-uses character rows
  const sig = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
  const bookSignature = (filename || 'book') + '#' + sig;

  // Extract text
  let text = '';
  const lower = String(filename).toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      const r = await pdfParse(buf);
      text = (r && r.text) ? String(r.text) : '';
    } else if (lower.endsWith('.txt') || lower.endsWith('.md')) {
      text = buf.toString('utf8');
    } else {
      return json(415, { error: 'Upload PDF or .txt for now.' });
    }
  } catch (e) {
    return json(500, { error: 'Could not read file: ' + (e?.message || 'parse error') });
  }
  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return json(422, { error: 'No text found (scanned PDF without OCR?)' });
  const truncated = text.length > TEXT_LIMIT;
  if (truncated) text = text.slice(0, TEXT_LIMIT);

  // Ask Claude to extract characters with structured JSON output
  const styleHint = book_style ? ` The user has chosen "${book_style}" as the visual style for the book; suggested prompts should reflect that.` : '';
  const system = 'You are a book editor extracting named characters and their physical descriptions for an illustrator. You output ONLY valid JSON, no prose.';
  const userPrompt =
    'Read the manuscript excerpt below and extract every named character who appears. For each character, output:\n' +
    '- name: the character\'s most-used name in the book\n' +
    '- description: 1-3 sentences describing their physical appearance, age, build, distinguishing features, typical attire — drawn ONLY from the text. If a feature is not mentioned, omit it. Do not invent.\n' +
    '- suggested_prompt: a single image-generation prompt of about 40-70 words for a portrait of this character.' + styleHint + ' The prompt should describe the person in the third person (e.g., "A woman in her late 50s..."), include the visible details from the description, and end with style/lighting hints. Do NOT include the character\'s name in the prompt.\n\n' +
    'Output JSON in this exact shape (no markdown fencing, no commentary):\n' +
    '{"characters":[{"name":"...","description":"...","suggested_prompt":"..."}]}\n\n' +
    'If no characters are clearly named, return {"characters":[]}.\n\n' +
    'MANUSCRIPT TEXT:\n' +
    text;

  let aiResp;
  try {
    aiResp = await callAnthropic(system, userPrompt, 'claude-sonnet-4-6', 2000);
  } catch (e) {
    return json(502, { error: 'AI error: ' + e.message });
  }
  const raw = aiResp?.content?.[0]?.text || '';
  let parsed;
  try {
    // Best-effort: strip any markdown fence the model may have added
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return json(502, { error: 'Could not parse character list from AI', raw: raw.slice(0, 400) });
  }
  const chars = Array.isArray(parsed?.characters) ? parsed.characters : [];

  // Persist (upsert) — re-uploading the same book updates rows but preserves portraits
  const rows = chars.map((c, i) => ({
    user_id:               user.id,
    book_signature:        bookSignature,
    book_title:            book_title || filename,
    book_style:            book_style || null,
    character_name:        String(c.name || '').trim(),
    character_description: String(c.description || '').trim(),
    suggested_prompt:      String(c.suggested_prompt || '').trim(),
    display_order:         i,
  })).filter(r => r.character_name);

  let saved = [];
  if (rows.length) {
    const { data, error } = await supabase
      .from('book_characters')
      .upsert(rows, { onConflict: 'user_id,book_signature,character_name' })
      .select();
    if (error) {
      console.error('[extract-book-characters] upsert failed:', error.message);
      return json(500, { error: 'Could not save characters: ' + error.message });
    }
    saved = data || [];
  }

  // Log usage (non-fatal)
  try {
    const inTok  = aiResp?.usage?.input_tokens  || 0;
    const outTok = aiResp?.usage?.output_tokens || 0;
    await supabase.from('anthropic_usage').insert({
      user_id: user.id, module: 'extract_book_characters', action_type: 'extract_book_characters',
      model: 'claude-sonnet-4-6',
      prompt_tokens: inTok, completion_tokens: outTok,
      total_tokens: inTok + outTok,
      cost_usd: (inTok / 1000) * 0.003 + (outTok / 1000) * 0.015,
    });
  } catch (_) {}

  return json(200, {
    book_signature: bookSignature,
    book_title:     book_title || filename,
    book_style:     book_style || null,
    truncated,
    text_chars:     text.length,
    characters:     saved.sort((a, b) => (a.display_order || 0) - (b.display_order || 0)),
  });
};
