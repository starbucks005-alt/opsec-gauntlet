/* ─────────────────────────────────────────────────────────────────────────────
   tg-voice — ElevenLabs proxy for The Gauntlet character voices

   GET /.netlify/functions/tg-voice?character=<id>&mode=<bio|role>

   Looks up the character's ElevenLabs voice_id (from judges_master.json or
   helpers_master.json) and the corresponding script text (from
   voice_scripts.json), calls ElevenLabs text-to-speech, and streams the
   resulting MP3 back to the browser. Audio is cacheable for a day so
   repeat plays of the same bio/role do not re-hit the API.

   Required env var: ELEVENLABS_API_KEY (set on Netlify site settings).

   No body content is sent by the caller. character_id and mode are the
   only inputs. The function trusts its own config files for voice_id and
   script text so the client cannot inject arbitrary text into ElevenLabs.
   ───────────────────────────────────────────────────────────────────────────── */

const judges = require('../../config/judges_master.json');
const helpers = require('../../config/helpers_master.json');
const scripts = require('../../config/voice_scripts.json');

const MODEL_ID = 'eleven_monolingual_v1';
const VOICE_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.75,
  style: 0.20,
  use_speaker_boost: true,
};

function findVoiceId(characterId) {
  const j = (judges.judges || []).find(x => x.id === characterId);
  if (j && j.voice_id) return j.voice_id;
  const h = (helpers.helpers || []).find(x => x.id === characterId);
  if (h && h.voice_id) return h.voice_id;
  return null;
}

function findScript(characterId, mode) {
  const entry = (scripts.scripts || {})[characterId];
  if (!entry) return null;
  return entry[mode] || null;
}

// Display name for the character, stripped of any parenthetical content
// (e.g. "Admiral Grace Nakamura (Ret.)" -> "Admiral Grace Nakamura") so the
// voice does not pronounce "parenthesis Ret dot".
function getCharacterDisplayName(characterId) {
  const j = (judges.judges || []).find(x => x.id === characterId);
  const h = (helpers.helpers || []).find(x => x.id === characterId);
  const raw = (j && j.name) || (h && h.name) || '';
  return raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
}

// Build the text actually sent to ElevenLabs. Two transforms applied:
//
//   1. Leading pause buffer. Without ". " up front, ElevenLabs starts the
//      audio mid-phoneme and HTML Audio playback clips the first word on the
//      client. The leading period is voiced as silence, not as "dot".
//
//   2. Auto-prepended name intro. Terry's rule: every clip starts with the
//      character's full name. We detect whether the script already opens
//      with the character's first name and only prepend if it does not, so
//      bios that already say "I'm Selene Voss." are not double-named.
function buildSpeechText(characterId, script) {
  const displayName = getCharacterDisplayName(characterId);

  // First name = first token after dropping honorifics. Used only to test
  // whether the script's opening already introduces the character.
  const baseName = displayName.replace(/^(Dr\.|Admiral|Prof\.|Mr\.|Ms\.|Mrs\.)\s+/i, '');
  const firstName = (baseName.split(/\s+/)[0] || '').toLowerCase();
  const opening = script.substring(0, 60).toLowerCase();
  const alreadyIntroduced = firstName && opening.includes(firstName);

  const namePrefix = (displayName && !alreadyIntroduced) ? `I'm ${displayName}. ` : '';
  const pausePrefix = '. ';

  return pausePrefix + namePrefix + script;
}

exports.handler = async (event) => {
  // CORS preflight (Netlify default origin only; tighten if needed)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const qs = event.queryStringParameters || {};
  const character = (qs.character || '').trim();
  const mode = (qs.mode || '').trim().toLowerCase();

  if (!character || !mode) {
    return jsonError(400, 'character and mode query params required');
  }
  if (!/^[a-z0-9_]+$/.test(character)) {
    return jsonError(400, 'invalid character id');
  }
  if (!['bio', 'role'].includes(mode)) {
    return jsonError(400, 'mode must be bio or role');
  }

  const voiceId = findVoiceId(character);
  if (!voiceId) return jsonError(404, 'character not found or has no voice');

  const rawText = findScript(character, mode);
  if (!rawText) return jsonError(404, 'no script for that character + mode');

  // Apply the pause buffer + auto name intro before handing off to ElevenLabs.
  const text = buildSpeechText(character, rawText);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'ELEVENLABS_API_KEY not configured');
  }

  let resp;
  try {
    resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: VOICE_SETTINGS,
      }),
    });
  } catch (err) {
    console.error('[tg-voice] fetch failure', err);
    return jsonError(502, 'tts network failure');
  }

  if (!resp.ok) {
    const detail = await safeRead(resp);
    console.error('[tg-voice] tts non-200', resp.status, detail);
    return jsonError(502, `tts upstream ${resp.status}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(buf.length),
      // Audio for a given character+mode is deterministic; cache one day.
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
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

async function safeRead(resp) {
  try { return await resp.text(); } catch { return ''; }
}
