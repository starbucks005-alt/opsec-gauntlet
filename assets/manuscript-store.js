/* ─────────────────────────────────────────────────────────────────────────────
   assets/manuscript-store.js — Greylander Press shared manuscript session
   Load via <script src="assets/manuscript-store.js" defer></script>

   After load, window.gpMs is available everywhere on the page.

   Storage:
     sessionStorage  gp_ms_pdf   base64 PDF  (per-tab; no persistent bloat)
     sessionStorage  gp_ms_text  extracted text (capped 150 K chars)
     localStorage    gp_ms_meta  lightweight metadata (cross-tab, persists)

   Events dispatched on window:
     gp-manuscript-ready    { detail: meta }   after save()
     gp-manuscript-cleared                     after clear()
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const META_KEY = 'gp_ms_meta';
  const PDF_KEY  = 'gp_ms_pdf';
  const TEXT_KEY = 'gp_ms_text';

  window.gpMs = {

    /* ── Save ──────────────────────────────────────────────────────────────── */
    save(filename, pdfBase64, text, wordCount, meta) {
      try { sessionStorage.setItem(PDF_KEY,  pdfBase64 || ''); } catch (e) {}
      try { sessionStorage.setItem(TEXT_KEY, (text || '').slice(0, 600000)); } catch (e) {}
      try {
        localStorage.setItem(META_KEY, JSON.stringify({
          filename:     filename      || '',
          wordCount:    wordCount     || 0,
          savedAt:      Date.now(),
          title:        meta?.title        || '',
          genre:        meta?.genre        || '',
          protagonist:  meta?.protagonist  || '',
          antagonist:   meta?.antagonist   || '',
          setting:      meta?.setting      || '',
          conflict:     meta?.conflict     || '',
          chapterCount: meta?.chapterCount || 0,
        }));
      } catch (e) {}
      window.dispatchEvent(new CustomEvent('gp-manuscript-ready', { detail: this.getMeta() }));
    },

    /* ── Retrieve ──────────────────────────────────────────────────────────── */
    getMeta()  { try { return JSON.parse(localStorage.getItem(META_KEY)); }   catch { return null; } },
    getPdf()   { try { return sessionStorage.getItem(PDF_KEY)  || null; }     catch { return null; } },
    getText()  { try { return sessionStorage.getItem(TEXT_KEY) || null; }     catch { return null; } },
    hasPdf()   { return !!this.getPdf(); },
    hasMeta()  { return !!this.getMeta(); },

    /* ── Reconstruct File object from stored base64 ────────────────────────── */
    toFile(name) {
      const b64 = this.getPdf();
      if (!b64) return null;
      try {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return new File([buf], name || 'manuscript.pdf', { type: 'application/pdf' });
      } catch { return null; }
    },

    /* ── Clear ─────────────────────────────────────────────────────────────── */
    clear() {
      try { localStorage.removeItem(META_KEY); }      catch (e) {}
      try { sessionStorage.removeItem(PDF_KEY); }     catch (e) {}
      try { sessionStorage.removeItem(TEXT_KEY); }    catch (e) {}
      window.dispatchEvent(new CustomEvent('gp-manuscript-cleared'));
    },
  };
})();
