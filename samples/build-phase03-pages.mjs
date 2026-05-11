/* Generate the 4 remaining Phase 03 dedicated pages by cloning prose-enricher.html
   and swapping copy / system-prompt / handler name. Run once: node samples/build-phase03-pages.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC  = fs.readFileSync(path.join(ROOT, 'prose-enricher.html'), 'utf8');

function build(swaps) {
  let out = SRC;
  for (const [from, to] of swaps) {
    if (out.indexOf(from) < 0) {
      console.warn('  !! pattern not found, skipping:', from.slice(0, 80));
      continue;
    }
    out = out.split(from).join(to);
  }
  return out;
}

/* ─── add-dialogue.html ────────────────────────────────────────────── */
const dialoguePrompt = `You are Grey, a literary ghost writer for Greylander Press, working as the Dialogue Doctor.

Your job: take the narrative-heavy scene the author gives you and add dialogue that fits the established characters and the work the scene is doing.

Rules:
- Preserve every plot beat in its original order. Do not invent new actions, decisions, or revelations.
- Preserve point of view, tense, and named characters. Use only voices already established in the scene.
- Each line of dialogue must do at least two things at once: reveal character AND advance the moment, or carry subtext AND deflect.
- People interrupt, evade, mishear, change the subject. Avoid stage-direction dialogue ("As you know, Bob").
- Dialogue tags: prefer "said" or no tag plus an action beat. Avoid synonyms for said (whispered, growled, retorted) unless they earn their place.
- Match the established prose voice in cadence and diction. The narration around the dialogue can stay almost the same.
- Never use em dashes. Use periods, commas, or short sentences instead.
- Return only the rewritten scene. No preamble, no notes, no markdown headers, no commentary.`;

fs.writeFileSync(path.join(ROOT, 'add-dialogue.html'), build([
  ['<title>Prose Enricher — Greylander Press</title>', '<title>Add Dialogue — Greylander Press</title>'],
  ['<h1 class="s-title">Prose <em>Enricher</em>.</h1>', '<h1 class="s-title">Add <em>Dialogue</em>.</h1>'],
  ['Paste a chapter or scene; Grey adds sensory detail, atmosphere, and texture without altering plot, character voice, or sequence of events.',
   'Paste a narrative-heavy scene; Grey weaves in dialogue that fits the established characters and earns the beats. Plot, sequence, and prose voice stay intact.'],
  ['<em>Atmosphere is craft, not decoration.</em> Paste a chapter and I will layer in the small specifics that put the reader in the room. The light, the temperature, the way the cup sits on the table. I will not change what happens, who says what, or the order of beats. Your scene, with the camera moved closer.',
   '<em>Dialogue is a character revealing themselves while trying to do something else.</em> Hand me a scene that is mostly description and I will give the people in it lines that match how they actually speak. I will not invent new beats or change what the scene is doing. The narration earns the dialogue; the dialogue earns the next beat.'],
  ['You are Grey, a literary ghost writer for Greylander Press, working as the Prose Enricher.\n\nYour job: take the chapter or scene the author gives you and add sensory detail, atmosphere, and texture without changing what happens.\n\nRules:\n- Preserve every plot beat in its original order. Do not add new actions, decisions, or revelations.\n- Preserve every line of dialogue. You may interleave brief action beats around dialogue, but do not change the words spoken.\n- Preserve point of view, tense, and named characters. Do not introduce new characters.\n- Add specifics, not adjectives. Light angle, temperature, sound, the way a hand rests on an object. Avoid generic intensifiers (very, really, somehow).\n- Match the established voice. If the prose is spare, stay spare. If it is dense, stay dense. Slightly enriched, not transformed.\n- Never use em dashes. Use periods, commas, or short sentences instead.\n- Return only the enriched chapter prose. No preamble, no notes, no markdown headers, no commentary.',
   dialoguePrompt],
  ['runEnrich', 'runDialogue'],
  ['✦ Enrich This Chapter', '✦ Add Dialogue to This Scene'],
  ['Enriched Draft', 'Scene with Dialogue'],
  ['Streaming enriched prose…', 'Streaming dialogue-enriched scene…'],
  ['keeps plot, voice, and beats intact', 'keeps plot, voice, and beats intact; weaves dialogue in'],
]));
console.log('add-dialogue.html');

/* ─── adapt-from-source.html ──────────────────────────────────────────── */
const adaptPrompt = `You are Grey, a literary ghost writer for Greylander Press, working as the Adaptation Architect.

Your job: take the screenplay, treatment, or scene outline the author gives you and produce a chapter-by-chapter outline for the prose adaptation.

Rules:
- Identify the structural acts in the source. Map each major beat to a chapter break.
- Where the source has a montage or jump cut, mark a chapter end. Where it has a sustained scene, that is the body of a chapter.
- For each chapter give: a 4-to-7-word chapter title (no numbers or labels), and a single tight sentence describing the beat in prose-novel terms (POV, central action, what shifts).
- Translate visual beats into interior or sensory ones. A close-up becomes "sees" or "notices." A slow push-in becomes a paragraph of building dread.
- Preserve every named character. Do not invent new ones. Do not change the genre.
- Output as a JSON array of objects with "title" and "desc" fields. Nothing else.
- Never use em dashes. Use periods, commas, or short sentences instead.`;

fs.writeFileSync(path.join(ROOT, 'adapt-from-source.html'), build([
  ['<title>Prose Enricher — Greylander Press</title>', '<title>Adapt from Source — Greylander Press</title>'],
  ['<h1 class="s-title">Prose <em>Enricher</em>.</h1>', '<h1 class="s-title">Adapt <em>from Source</em>.</h1>'],
  ['Paste a chapter or scene; Grey adds sensory detail, atmosphere, and texture without altering plot, character voice, or sequence of events.',
   'Paste a screenplay, treatment, or scene outline; Grey returns a chapter outline shaped for prose. Beats become chapter breaks. Action lines become interiority and description.'],
  ['<em>Atmosphere is craft, not decoration.</em> Paste a chapter and I will layer in the small specifics that put the reader in the room. The light, the temperature, the way the cup sits on the table. I will not change what happens, who says what, or the order of beats. Your scene, with the camera moved closer.',
   '<em>Screenplay shows; prose shows AND tells what showing means.</em> Hand me a script, a beat sheet, or a treatment, and I will lay out the chapters that adaptation needs. Where the camera held, the chapter holds. Where the slug line jumps, the chapter cuts. Where the actor would have inhabited the line, the prose has to do that work.'],
  ['You are Grey, a literary ghost writer for Greylander Press, working as the Prose Enricher.\n\nYour job: take the chapter or scene the author gives you and add sensory detail, atmosphere, and texture without changing what happens.\n\nRules:\n- Preserve every plot beat in its original order. Do not add new actions, decisions, or revelations.\n- Preserve every line of dialogue. You may interleave brief action beats around dialogue, but do not change the words spoken.\n- Preserve point of view, tense, and named characters. Do not introduce new characters.\n- Add specifics, not adjectives. Light angle, temperature, sound, the way a hand rests on an object. Avoid generic intensifiers (very, really, somehow).\n- Match the established voice. If the prose is spare, stay spare. If it is dense, stay dense. Slightly enriched, not transformed.\n- Never use em dashes. Use periods, commas, or short sentences instead.\n- Return only the enriched chapter prose. No preamble, no notes, no markdown headers, no commentary.',
   adaptPrompt],
  ['runEnrich', 'runAdapt'],
  ['✦ Enrich This Chapter', '✦ Adapt to Chapter Outline'],
  ['Enriched Draft', 'Chapter Outline (Adapted from Source)'],
  ['Streaming enriched prose…', 'Mapping beats to chapter outline…'],
  ['keeps plot, voice, and beats intact', 'maps source beats to chapter breaks'],
  ['placeholder="Paste up to ~6,000 words here. Grey works best on a single scene or chapter at a time."',
   'placeholder="Paste your screenplay, treatment, beat sheet, or scene outline. Grey will return a JSON-formatted chapter outline."'],
]));
console.log('adapt-from-source.html');

/* ─── structural-rebuild.html — calls process-author-tool (auth required) */
const rebuildPrompt = `You are Grey, restructuring a chapter or act of fiction for an author at Greylander Press. The author has identified that the current structure needs more than polish. Beats are missing, escalation is misordered, or scenes are not earning their place.

Your job: rebuild the structure. Produce the corrected sequence of beats in the chapter or act, each beat written as a single tight sentence describing what happens, who acts, and what shifts.

Rules:
- Identify the dramatic problem. Diagnose in one sentence at the top: what is structurally weak in the original.
- Then return a beat-by-beat outline of the rebuilt chapter or act. Each beat: numbered, one sentence, naming the POV character and the change the beat creates.
- Preserve every named character. Do not introduce new ones. Do not change the genre or the established arc; rebuild the scaffolding within those constraints.
- Cut beats that do not earn their place. Add only beats that the existing arc actually needs.
- End with a one-sentence note on what the rebuilt structure now achieves that the original did not.
- Never use em dashes. Use periods, commas, or short sentences instead.
- Return only the diagnosis line, the numbered beats, and the closing note. No preamble, no markdown headers beyond the numbers.`;

const rebuildPage = build([
  ['<title>Prose Enricher — Greylander Press</title>', '<title>Structural Rebuild — Greylander Press</title>'],
  ['<h1 class="s-title">Prose <em>Enricher</em>.</h1>', '<h1 class="s-title">Structural <em>Rebuild</em>.</h1>'],
  ['Paste a chapter or scene; Grey adds sensory detail, atmosphere, and texture without altering plot, character voice, or sequence of events.',
   'Paste a chapter or act that is structurally underwater. Grey diagnoses what is weak, then returns a rebuilt beat sequence within the same characters and arc.'],
  ['<em>Atmosphere is craft, not decoration.</em> Paste a chapter and I will layer in the small specifics that put the reader in the room. The light, the temperature, the way the cup sits on the table. I will not change what happens, who says what, or the order of beats. Your scene, with the camera moved closer.',
   '<em>When polish will not save it.</em> Paste a chapter or an act and I will name what is structurally weak: missing escalation, mis-ordered reveals, scenes that do not earn their place. Then I will rebuild the beat sequence inside your characters and your arc. New scaffolding, your story.'],
  ['runEnrich', 'runRebuild'],
  ['✦ Enrich This Chapter', '✦ Rebuild the Structure'],
  ['~3 credits per pass · keeps plot, voice, and beats intact', '4 credits per pass · auth required'],
  ['Enriched Draft', 'Rebuilt Beat Sequence'],
]);
// Replace the entire run handler block with the auth + process-author-tool variant
const rebuildHandler = `window.runRebuild = async function(){
  const chapter = document.getElementById('pn-chapter').value.trim();
  if (chapter.length < 200){ document.getElementById('run-status').textContent = 'Paste at least a paragraph or two.'; return; }
  if (chapter.length > 8000){ document.getElementById('run-status').textContent = 'Trim to under 8,000 characters for one pass.'; return; }
  const session = window._gpSession;
  if (!session || !session.user){ document.getElementById('run-status').textContent = 'Sign in on the homepage first; structural rebuild is credit-gated.'; return; }
  const btn = document.getElementById('run-btn');
  const status = document.getElementById('run-status');
  const out = document.getElementById('output-prose');
  btn.disabled = true;
  status.textContent = 'Grey is reading the structure…';
  document.getElementById('output-area').classList.add('visible');
  out.textContent = '';

  try {
    const res = await fetch('/.netlify/functions/process-author-tool', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ tool_type: 'structural_rebuild', payload: { chapter } }),
    });
    if (res.status === 402){ const d = await res.json(); status.textContent = \`Insufficient credits. Need \${d.needed}, have \${d.have}.\`; btn.disabled = false; return; }
    if (!res.ok){ const d = await res.json().catch(()=>({})); status.textContent = 'Error: ' + (d.error || 'HTTP ' + res.status); btn.disabled = false; return; }
    const data = await res.json();
    out.textContent = data.result || data.output || JSON.stringify(data, null, 2);
    status.textContent = \`Done. \${data.credits_remaining ?? '?'} credits left.\`;
  } catch (err){
    status.textContent = 'Network error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
};`;
const rebuildOut = rebuildPage.replace(/window\.runRebuild = async function\(\)[\s\S]*?\n\};/, rebuildHandler);
fs.writeFileSync(path.join(ROOT, 'structural-rebuild.html'), rebuildOut);
console.log('structural-rebuild.html');

/* ─── descriptor-library.html — calls process-author-tool descriptor_library */
const descriptorPage = build([
  ['<title>Prose Enricher — Greylander Press</title>', '<title>Descriptor Library — Greylander Press</title>'],
  ['<h1 class="s-title">Prose <em>Enricher</em>.</h1>', '<h1 class="s-title">Descriptor <em>Library</em>.</h1>'],
  ['Paste a chapter or scene; Grey adds sensory detail, atmosphere, and texture without altering plot, character voice, or sequence of events.',
   'Paste a passage with repetitive vocabulary or generic description. Grey returns the same passage with sharper, less-repeated word choices. Voice and meaning preserved.'],
  ['<em>Atmosphere is craft, not decoration.</em> Paste a chapter and I will layer in the small specifics that put the reader in the room. The light, the temperature, the way the cup sits on the table. I will not change what happens, who says what, or the order of beats. Your scene, with the camera moved closer.',
   '<em>Every word a writer reuses is a word the reader notices.</em> Paste a passage where the same verbs, adjectives, or sense-images keep showing up. I will swap repetitions for sharper alternatives that fit the voice and the moment. Same prose, fewer echoes.'],
  ['runEnrich', 'runDescriptor'],
  ['✦ Enrich This Chapter', '✦ Sharpen Repetitions'],
  ['~3 credits per pass · keeps plot, voice, and beats intact', '2 credits per pass · auth required'],
  ['Enriched Draft', 'Sharpened Passage'],
  ['placeholder="Paste up to ~6,000 words here. Grey works best on a single scene or chapter at a time."',
   'placeholder="Paste up to ~8,000 characters of prose here. Works best on a single scene or short passage where you can hear the repetitions."'],
]);
const descriptorHandler = `window.runDescriptor = async function(){
  const chapter = document.getElementById('pn-chapter').value.trim();
  if (chapter.length < 100){ document.getElementById('run-status').textContent = 'Paste a paragraph or more.'; return; }
  if (chapter.length > 8000){ document.getElementById('run-status').textContent = 'Trim to under 8,000 characters.'; return; }
  const session = window._gpSession;
  if (!session || !session.user){ document.getElementById('run-status').textContent = 'Sign in on the homepage first; the Descriptor Library is credit-gated.'; return; }
  const btn = document.getElementById('run-btn');
  const status = document.getElementById('run-status');
  const out = document.getElementById('output-prose');
  btn.disabled = true;
  status.textContent = 'Grey is sharpening repetitions…';
  document.getElementById('output-area').classList.add('visible');
  out.textContent = '';

  try {
    const res = await fetch('/.netlify/functions/process-author-tool', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ tool_type: 'descriptor_library', payload: { chapter } }),
    });
    if (res.status === 402){ const d = await res.json(); status.textContent = \`Insufficient credits. Need \${d.needed}, have \${d.have}.\`; btn.disabled = false; return; }
    if (!res.ok){ const d = await res.json().catch(()=>({})); status.textContent = 'Error: ' + (d.error || 'HTTP ' + res.status); btn.disabled = false; return; }
    const data = await res.json();
    out.textContent = data.result || data.output || JSON.stringify(data, null, 2);
    status.textContent = \`Done. \${data.credits_remaining ?? '?'} credits left.\`;
  } catch (err){
    status.textContent = 'Network error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
};`;
const descriptorOut = descriptorPage.replace(/window\.runDescriptor = async function\(\)[\s\S]*?\n\};/, descriptorHandler);
fs.writeFileSync(path.join(ROOT, 'descriptor-library.html'), descriptorOut);
console.log('descriptor-library.html');

console.log('done.');
