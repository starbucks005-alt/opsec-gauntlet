/* ─────────────────────────────────────────────────────────────────────────────
   tg-recommend.js — The Gauntlet judge-selection recommendation engine

   Pure math, no LLM. Given a submission requirement vector R (one value per
   dimension) and the judge roster, returns the top triad of judges to run the
   Gauntlet. The same R + same judges always produces the same triad.

   Algorithm (from GAUNTLET_PRODUCT_SPEC.md + Doc #3):

     1. Cosine similarity per judge:
          sim_j = (R · L_j) / (|R| · |L_j|)

     2. Generate every triad (C(9,3) = 84 combinations).

     3. Score each triad as a weighted sum:
          triadScore = 0.35·COV + 0.25·COMP + 0.20·TYPE + 0.10·RISK + 0.10·EVID

        COV   — fraction of R's *needed* dimensions covered by the triad.
                A dimension is "needed" if R[d] >= NEEDED_THRESHOLD (0.3).
                It is "covered" if any judge in the triad has L_j[d] >=
                COVER_THRESHOLD (0.5).
        COMP  — complementarity. Mean pairwise distance (1 - cosine) between
                the three judges' lens vectors. Punishes redundancy; rewards
                a triad whose perspectives differ.
        TYPE  — submission-type modifier. Stubbed at 1.0 until intake (Gate D)
                provides a submission type to bias the math toward.
        RISK  — risk adequacy. R.risk multiplied by the triad's strongest
                risk-sensitive judge. Triads carry more risk coverage when the
                submission has more risk to evaluate.
        EVID  — evidence adequacy. Same shape as RISK but on the evidence
                dimension.

     4. Sort descending. Return the top triad's three judge ids.

   Exposed on window.tgRecommend so the page script can use it without a
   module bundler.

   When Gate D wires the intake form, replace defaultRequirementVector() with
   a real submission-to-R mapping. The rest of this engine doesn't change.
   ───────────────────────────────────────────────────────────────────────────── */

(function(){
  'use strict';

  const NEEDED_THRESHOLD = 0.30;   // R[d] above this means the user wants this dimension addressed
  const COVER_THRESHOLD  = 0.50;   // a judge with L[d] above this is treated as covering dimension d
  const W_COV  = 0.35;
  const W_COMP = 0.25;
  const W_TYPE = 0.20;
  const W_RISK = 0.10;
  const W_EVID = 0.10;

  /** Cosine similarity between two equal-length numeric arrays. */
  function cosine(a, b){
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++){
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /** Project a judge's dimension_vector onto the canonical dims order. */
  function vectorize(judge, dims){
    const v = judge.dimension_vector || {};
    return dims.map(d => (typeof v[d] === 'number') ? v[d] : 0);
  }

  /** Project an R object onto the canonical dims order. */
  function rArray(R, dims){
    return dims.map(d => (typeof R[d] === 'number') ? R[d] : 0);
  }

  /** Generate every 3-element combination of the input array, in order. */
  function triadsOf(arr){
    const out = [];
    const n = arr.length;
    for (let i = 0; i < n - 2; i++){
      for (let j = i + 1; j < n - 1; j++){
        for (let k = j + 1; k < n; k++){
          out.push([arr[i], arr[j], arr[k]]);
        }
      }
    }
    return out;
  }

  /**
   * Pure math, no side effects.
   * @param {object} R       Requirement vector keyed by dimension name.
   * @param {array}  judges  Array of judge config objects (from judges_master.json).
   * @param {array}  dims    Canonical dimension order (from judges_master.json).
   * @param {object} [opts]  Optional. submissionType (string) — reserved for Gate D.
   * @returns {array}        Top triad as an array of three judge ids.
   */
  function recommendTriad(R, judges, dims, opts){
    opts = opts || {};
    const Rvec = rArray(R, dims);

    // Decorate each judge with its lens vector projected onto dims.
    const enriched = judges.map(j => {
      const vec = vectorize(j, dims);
      return { id: j.id, judge: j, vec: vec, sim: cosine(Rvec, vec) };
    });

    // Walk every triad and score it.
    const triads = triadsOf(enriched);
    let best = null;
    let bestScore = -Infinity;

    for (const t of triads){
      const score = scoreTriad(t, R, dims);
      if (score > bestScore){
        bestScore = score;
        best = t;
      }
    }

    return best ? best.map(t => t.id) : [];
  }

  /** Score one triad against the requirement vector R. */
  function scoreTriad(triad, R, dims){
    // COV — fraction of R's needed dimensions covered by at least one judge.
    let needed = 0, covered = 0;
    for (let d = 0; d < dims.length; d++){
      const want = R[dims[d]] || 0;
      if (want >= NEEDED_THRESHOLD){
        needed++;
        if (triad.some(t => t.vec[d] >= COVER_THRESHOLD)) covered++;
      }
    }
    const cov = needed > 0 ? (covered / needed) : 0;

    // COMP — average pairwise distance (1 - cosine) between the three lens vectors.
    let distSum = 0, pairs = 0;
    for (let i = 0; i < triad.length; i++){
      for (let j = i + 1; j < triad.length; j++){
        distSum += 1 - cosine(triad[i].vec, triad[j].vec);
        pairs++;
      }
    }
    const comp = pairs > 0 ? (distSum / pairs) : 0;

    // TYPE — submission-type weighting. Stubbed at 1.0 until Gate D.
    const type = 1.0;

    // RISK — R.risk times the triad's most risk-aware judge.
    const rRisk = (R.risk || 0);
    const triadRisk = Math.max.apply(null, triad.map(t => t.judge.dimension_vector.risk || 0));
    const risk = rRisk * triadRisk;

    // EVID — same shape, evidence dimension.
    const rEvid = (R.evidence || 0);
    const triadEvid = Math.max.apply(null, triad.map(t => t.judge.dimension_vector.evidence || 0));
    const evid = rEvid * triadEvid;

    return (W_COV * cov) + (W_COMP * comp) + (W_TYPE * type)
         + (W_RISK * risk) + (W_EVID * evid);
  }

  /**
   * Placeholder R used until the intake form (Gate D) computes a real one
   * from the user's submission. Tuned as a balanced "generic idea" profile:
   * clear structure matters, basic viability matters, moderate risk and
   * evidence attention, lighter weighting on the human/cultural axes.
   */
  function defaultRequirementVector(){
    return {
      structure:  0.65,
      viability:  0.60,
      risk:       0.40,
      narrative:  0.45,
      evidence:   0.55,
      cultural:   0.30,
      psych:      0.35,
      compliance: 0.25
    };
  }

  /** Debugging helper. Returns per-judge similarity scores for the current R. */
  function scoreEachJudge(R, judges, dims){
    const Rvec = rArray(R, dims);
    return judges.map(j => ({
      id: j.id,
      name: j.name,
      sim: cosine(Rvec, vectorize(j, dims))
    })).sort((a, b) => b.sim - a.sim);
  }

  // Expose on window — no module bundler in slice 1.
  window.tgRecommend = {
    recommendTriad: recommendTriad,
    defaultRequirementVector: defaultRequirementVector,
    scoreEachJudge: scoreEachJudge,
    cosine: cosine
  };

})();
