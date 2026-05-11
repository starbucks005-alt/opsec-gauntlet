/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Workshop assist (background)

   Triggered by workshop.js (assist mode) with a job_id only. Reads
   manuscript_text + working_section + assist_mode from the workshop_jobs row,
   runs the Claude assist call, persists result, deducts credits, clears
   transient inputs.

   Background function: returns 202 immediately to caller; the actual work
   continues for up to 15 minutes (no 26s sync ceiling).
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const ASSIST_COST = 3;
const CTX_CAP  = 350000;       // manuscript context (~88k tokens — fits Sonnet 4.6 easily under 15min BG timeout)
const SECTION_CAP = 15000;

const ASSIST_MODES = {
  enrich: {
    name: 'ENRICH',
    instruction: 'Add sensory details, atmosphere, and character interiority to the working section. Do not change dialogue, plot beats, or extend the scene beyond its current endpoint. Return the full section with your additions woven naturally into the existing prose.',
  },
  dialogue: {
    name: 'DIALOGUE',
    instruction: 'Identify moments in the working section where dialogue would strengthen the scene. Weave in natural exchanges between the characters present. Match the voice and register of each character as established in the manuscript. Do not change existing dialogue. Return the full section with dialogue woven in.',
  },
  continue: {
    name: 'CONTINUE',
    instruction: 'Write the next 600–900 words that follow the working section. Match the author\'s established voice, POV, pacing, and tone exactly. Advance the story in a direction consistent with what has been established. End at a natural break point.',
  },
  diagnose: {
    name: 'DIAGNOSE',
    instruction: 'Give an honest, specific structural diagnosis of the working section. Cover: (1) what is working and why, (2) what is weak and specifically why, (3) what the reader is feeling at each major beat, (4) the single most urgent fix. Be direct. No flattery. This is the same standard applied to professionally published fiction.',
  },
  rebuild: {
    name: 'REBUILD',
    instruction: 'Identify the scene beats in the working section. Return a rebuilt version with the same content, characters, and plot points but stronger structural architecture. Tighten pacing, improve entry and exit points, ensure each beat earns its place. Explain your structural choices in 2-3 sentences before the rebuilt text.',
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400 }; }

  const { job_id } = body;
  if (!job_id) return { statusCode: 400 };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    console.error('[workshop-assist-bg] missing env');
    return { statusCode: 500 };
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Load job
  const { data: job, error: jobErr } = await supabase
    .from('workshop_jobs')
    .select('*')
    .eq('id', job_id)
    .single();

  if (jobErr || !job) {
    console.error('[workshop-assist-bg] job not found:', job_id, jobErr);
    return { statusCode: 404 };
  }

  if (job.status !== 'queued') {
    console.warn('[workshop-assist-bg] job not queued, skipping:', job_id, job.status);
    return { statusCode: 200 };
  }

  await supabase.from('workshop_jobs')
    .update({ status: 'running' })
    .eq('id', job_id);

  const modeConfig = ASSIST_MODES[job.assist_mode];
  if (!modeConfig) {
    await failJob(supabase, job_id, 'Unknown assist mode: ' + job.assist_mode);
    return { statusCode: 200 };
  }

  // Build context (first 85% + last 15% if over cap)
  let ctx = job.manuscript_text || '';
  if (ctx.length > CTX_CAP) {
    const firstChunk = Math.floor(CTX_CAP * 0.85);
    const lastChunk  = CTX_CAP - firstChunk;
    ctx = ctx.slice(0, firstChunk) + '\n\n[... manuscript truncated for context ...]\n\n' + ctx.slice(ctx.length - lastChunk);
  }

  const section = (job.working_section || '').length > SECTION_CAP
    ? job.working_section.slice(0, SECTION_CAP)
    : (job.working_section || '');

  const system = `You are Grey, the Greylander Press writing partner. An author has uploaded a partial manuscript and needs your help.

You have read the complete uploaded manuscript. You know the characters, their voices, the plot established so far, the tone, the POV, and where the story is heading.

FULL MANUSCRIPT CONTEXT:
---
${ctx}
---

MODE: ${modeConfig.name}

INSTRUCTION:
${modeConfig.instruction}

STYLE RULES:
- Never use em dashes (—). Use periods, commas, or colons.
- No hedging language ("I think", "perhaps", "might").
- No meta-commentary about what you're doing. Just do it.
- ALWAYS finish your output on a complete sentence. If you sense you are approaching length limits, wrap up the current scene cleanly rather than continuing into new territory. A short, complete passage is better than a long, truncated one.`;

  const userMessage = `WORKING SECTION (apply ${modeConfig.name.toLowerCase()} to this):
---
${section}
---

Proceed.`;

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.75,
      system,
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (err) {
    console.error('[workshop-assist-bg] Anthropic error:', err);
    await failJob(supabase, job_id, err?.message || 'AI provider error');
    return { statusCode: 200 };
  }

  const result = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  if (!result) {
    await failJob(supabase, job_id, 'AI returned empty result');
    return { statusCode: 200 };
  }

  // Deduct credits
  const { data: balRow } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', job.user_id)
    .single();
  const balance = balRow?.balance ?? 0;
  const newBalance = Math.max(0, balance - ASSIST_COST);
  await supabase.from('gp_credits')
    .update({ balance: newBalance })
    .eq('user_id', job.user_id);

  // Persist result, clear transient inputs
  await supabase.from('workshop_jobs')
    .update({
      status: 'complete',
      result,
      stop_reason: resp.stop_reason || null,
      credits_charged: ASSIST_COST,
      credits_remaining: newBalance,
      manuscript_text: null,
      working_section: null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', job_id);

  return { statusCode: 200 };
};

async function failJob(supabase, jobId, message) {
  await supabase.from('workshop_jobs')
    .update({
      status: 'failed',
      error_message: message,
      manuscript_text: null,
      working_section: null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}
