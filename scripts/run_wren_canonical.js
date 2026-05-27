/* ─────────────────────────────────────────────────────────────────────────────
   run_wren_canonical.js

   Capture a canonical Wren patent-assessment output for a benchmark case.
   Hits the LIVE production Netlify functions so the captured output is
   byte-for-byte what a real client would receive.

   Usage:
     node scripts/run_wren_canonical.js <case_slug>

   Reads:  scripts/wren_benchmark_inputs/<slug>.txt
   Writes: config/wren_benchmark_cases.json (cases.<slug>)

   The reality_panel field is left untouched if it already exists; only
   the Wren-side canonical fields are refreshed. This way re-baselining
   Wren does not blow away the curated reality panel.
   ───────────────────────────────────────────────────────────────────────────── */

const fs   = require('fs');
const path = require('path');

const PROD_BASE = 'https://the-gauntlet.netlify.app';
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'wren_benchmark_cases.json');

const CASE_TITLES = {
  safetemp:      { title: 'SafeTemp Disposable Cups',     domain: 'Thermal Kinetics & Public Safety' },
  pure_crave:    { title: 'Pure Crave Appetite Gum',      domain: 'Chemical CPG' },
  second_chance: { title: 'Second Chance Fitness App',    domain: 'Behavioral Health Software UI' },
};

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('usage: node scripts/run_wren_canonical.js <case_slug>');
    process.exit(1);
  }
  const briefFile = path.join(__dirname, 'wren_benchmark_inputs', `${slug}.txt`);
  if (!fs.existsSync(briefFile)) {
    console.error(`brief file not found: ${briefFile}`);
    process.exit(1);
  }
  const brief = fs.readFileSync(briefFile, 'utf8').trim();
  console.log(`[${slug}] brief loaded (${brief.length} chars)`);

  // ── Phase 1: extract queries + run SerpAPI patent search.
  console.log(`[${slug}] phase 1: queries + prior-art search...`);
  const t1 = Date.now();
  const r1 = await fetch(`${PROD_BASE}/.netlify/functions/tg-wren-patent-queries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief, name: '' }),
  });
  if (!r1.ok) {
    const t = await r1.text();
    console.error(`phase 1 failed: HTTP ${r1.status}`);
    console.error(t);
    process.exit(1);
  }
  const phase1 = await r1.json();
  console.log(`[${slug}] phase 1 ok in ${Date.now()-t1}ms`);
  console.log(`   queries:    ${(phase1.queries||[]).length}`);
  console.log(`   prior_art:  ${(phase1.prior_art||[]).length} raw results`);
  console.log(`   tech_summary: ${(phase1.technical_summary||'').slice(0,180)}`);

  // ── Phase 2: analyze.
  console.log(`[${slug}] phase 2: analysis...`);
  const t2 = Date.now();
  const r2 = await fetch(`${PROD_BASE}/.netlify/functions/tg-wren-patent-analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief,
      name: '',
      queries:           phase1.queries,
      technical_summary: phase1.technical_summary,
      prior_art:         phase1.prior_art,
    }),
  });
  if (!r2.ok) {
    const t = await r2.text();
    console.error(`phase 2 failed: HTTP ${r2.status}`);
    console.error(t);
    process.exit(1);
  }
  const phase2 = await r2.json();
  console.log(`[${slug}] phase 2 ok in ${Date.now()-t2}ms`);

  // ── Persist canonical.
  let store = { version: 1, last_updated: null, cases: {} };
  if (fs.existsSync(CONFIG_FILE)) {
    try { store = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (err) { console.warn('existing config unparseable, rebuilding'); }
  }
  const today = new Date().toISOString().slice(0, 10);
  const meta = CASE_TITLES[slug] || { title: slug, domain: '' };

  store.last_updated = today;
  store.cases = store.cases || {};
  const existing = store.cases[slug] || {};
  store.cases[slug] = {
    slug,
    title:                 meta.title,
    domain:                meta.domain,
    status:                'live',
    client_brief:          brief,
    canonical_wren_output: phase2,
    canonical_run_date:    today,
    reality_panel:         existing.reality_panel || null,
  };

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2));
  console.log(`[${slug}] canonical written to ${CONFIG_FILE}`);

  // ── Summary printout for the human in the loop.
  console.log('\n----- WREN OUTPUT SUMMARY -----');
  console.log(`queries_used:    ${(phase2.queries_used||[]).length}`);
  console.log(`prior_art:       ${(phase2.prior_art||[]).length} entries`);
  console.log(`cpc_codes:       ${(phase2.cpc_codes||[]).length}`);
  console.log(`strong_claims:   ${(phase2.patentability?.strong_claims||[]).length}`);
  console.log(`weak_claims:    ${(phase2.patentability?.weak_claims||[]).length}`);
  console.log(`gaps:            ${(phase2.patentability?.gaps||[]).length}`);
  console.log(`next_steps:      ${(phase2.next_steps||[]).length}`);
  console.log('');
  console.log(`patentability:\n  ${phase2.patentability?.summary || '(empty)'}`);
  console.log('');
  console.log(`rationale:\n  ${phase2.rationale || '(empty)'}`);
}

main().catch(err => {
  console.error('fatal:', err && err.message || err);
  process.exit(1);
});
