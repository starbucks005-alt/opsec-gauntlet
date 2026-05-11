// netlify/functions/story-world-pdf.js
// Builds a PDF of one Story World page, or the whole book.
// Honors per-book layout choices: page_size, text_font, text_size, text_align.
// GET ?book_id=...                     → full book
// GET ?book_id=...&page_id=...         → single page
// Returns: application/pdf

const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// fontkit is required only when the user picks the handwritten font.
// Lazy-load so a missing/broken fontkit install can't crash the whole module.
let _fontkit = undefined;
function getFontkit() {
  if (_fontkit !== undefined) return _fontkit;
  try { _fontkit = require('@pdf-lib/fontkit'); }
  catch (e) { console.error('[story-world-pdf] fontkit require failed:', e.message); _fontkit = null; }
  return _fontkit;
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'story-worlds';

// Page sizes in PDF points (1 inch = 72 points)
const PAGE_SIZES = {
  letter: [612, 792],          // 8.5 x 11 in
  a4:     [595.28, 841.89],    // 210 x 297 mm
  square: [576, 576],          // 8 x 8 in
  trade:  [432, 648],          // 6 x 9 in
};

const TEXT_SIZE_MAP = {
  small:  { story: 11, picture: 14, comic: 11 },
  medium: { story: 13, picture: 17, comic: 13 },
  large:  { story: 17, picture: 22, comic: 17 },
  xl:     { story: 22, picture: 28, comic: 22 },
};

function jsonError(status, msg) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: msg }),
  };
}

async function getImageBytes(storagePath) {
  if (!storagePath) return null;
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error || !data) return null;
  const arrayBuf = await data.arrayBuffer();
  return new Uint8Array(arrayBuf);
}

async function embedImage(pdfDoc, bytes, contentType) {
  if (!bytes) return null;
  const isJpeg = (contentType && /jpe?g/i.test(contentType));
  try {
    return isJpeg ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
  } catch (_) {
    try { return isJpeg ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes); }
    catch { return null; }
  }
}

function loadCustomFontBytes(fileName) {
  const candidates = [
    path.join(process.cwd(), 'assets', 'fonts', fileName),
    path.join(__dirname, '..', '..', 'assets', 'fonts', fileName),
    path.join(__dirname, 'assets', 'fonts', fileName),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p); } catch (_) {}
  }
  return null;
}

async function loadFonts(pdfDoc, fontChoice) {
  const fonts = {
    times:     await pdfDoc.embedFont(StandardFonts.TimesRoman),
    timesBold: await pdfDoc.embedFont(StandardFonts.TimesRomanBold),
    helv:      await pdfDoc.embedFont(StandardFonts.Helvetica),
    helvBold:  await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    courier:   await pdfDoc.embedFont(StandardFonts.Courier),
    courierBold: await pdfDoc.embedFont(StandardFonts.CourierBold),
    caveat:    null,
  };

  if (fontChoice === 'caveat') {
    try {
      const fk = getFontkit();
      const bytes = fk ? loadCustomFontBytes('IndieFlower-Regular.ttf') : null;
      if (fk && bytes) {
        pdfDoc.registerFontkit(fk);
        fonts.handwritten = await pdfDoc.embedFont(new Uint8Array(bytes));
      } else {
        console.error('[story-world-pdf] handwritten font unavailable; falling back to Times');
      }
    } catch (e) {
      console.error('[story-world-pdf] failed to embed handwritten font:', e.message);
    }
  }

  // Resolve user font choice → body font + display font
  // Title is always Times Bold for reliable measurement (custom fonts can
  // miscalculate glyph advances and overflow the title page).
  let body, display;
  switch (fontChoice) {
    case 'helvetica': body = fonts.helv;    display = fonts.helvBold;    break;
    case 'courier':   body = fonts.courier; display = fonts.courierBold; break;
    case 'caveat':    body = fonts.handwritten || fonts.times; display = fonts.timesBold; break;
    case 'times':
    default:          body = fonts.times;   display = fonts.timesBold;   break;
  }
  return { body, display, titleBold: fonts.timesBold, footerFont: fonts.helv };
}

function wrapLines(font, text, fontSize, maxWidth) {
  const lines = [];
  const paragraphs = String(text).split(/\n+/);
  for (const para of paragraphs) {
    if (!para.trim()) { lines.push(''); continue; }
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      let w;
      try { w = font.widthOfTextAtSize(candidate, fontSize); }
      catch { w = candidate.length * fontSize * 0.5; }
      if (w > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    lines.push('');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function alignX(font, line, size, leftEdge, blockWidth, align) {
  if (align === 'center') {
    let w; try { w = font.widthOfTextAtSize(line, size); } catch { w = line.length * size * 0.5; }
    return leftEdge + (blockWidth - w) / 2;
  }
  if (align === 'right') {
    let w; try { w = font.widthOfTextAtSize(line, size); } catch { w = line.length * size * 0.5; }
    return leftEdge + blockWidth - w;
  }
  return leftEdge;
}

async function drawTitlePage(pdfDoc, book, fonts, pageWH, margin) {
  const [w, h] = pageWH;
  const page = pdfDoc.addPage([w, h]);

  // For handwritten books, render the title in the handwritten font too so the
  // cover and inside pages feel cohesive. Patrick Hand has clean static metrics
  // (unlike the original variable Caveat), so the title won't overflow.
  // Fall back to Times Bold if the custom font failed to load.
  const useHandwrittenTitle = book.text_font === 'caveat' && fonts.body && fonts.body !== fonts.times;
  const titleFont = useHandwrittenTitle ? fonts.body : fonts.titleBold;
  let titleSize = Math.min(40, w * 0.06);
  // Auto-shrink the title until the longest word fits the printable width.
  const printable = w - 2 * margin;
  const longestWord = (book.title || 'Story World').split(/\s+/).reduce((a, b) => a.length >= b.length ? a : b, '');
  while (titleSize > 14) {
    let wWidth;
    try { wWidth = titleFont.widthOfTextAtSize(longestWord, titleSize); } catch { wWidth = longestWord.length * titleSize * 0.55; }
    if (wWidth <= printable) break;
    titleSize -= 2;
  }
  const titleLines = wrapLines(titleFont, book.title || 'Story World', titleSize, printable);
  let y = h * 0.62;
  for (const line of titleLines) {
    const x = alignX(titleFont, line, titleSize, margin, w - 2 * margin, 'center');
    page.drawText(line, { x, y, size: titleSize, font: titleFont, color: rgb(0.1, 0.1, 0.1) });
    y -= titleSize * 1.2;
  }

  const sub = 'A Story World';
  const subSize = Math.min(14, w * 0.022);
  const subX = alignX(fonts.body, sub, subSize, margin, w - 2 * margin, 'center');
  page.drawText(sub, { x: subX, y: y - 14, size: subSize, font: fonts.body, color: rgb(0.45, 0.40, 0.32) });

  const foot = 'greylanderpress.com';
  const footSize = 9;
  const footX = alignX(fonts.footerFont, foot, footSize, margin, w - 2 * margin, 'center');
  page.drawText(foot, { x: footX, y: margin, size: footSize, font: fonts.footerFont, color: rgb(0.55, 0.55, 0.55) });
}

async function drawStoryPage(pdfDoc, page, book, fonts, pageWH, margin) {
  const [w, h] = pageWH;
  const pdfPage = pdfDoc.addPage([w, h]);
  const mode  = book.mode || 'story';
  const align = book.text_align || 'center';
  const sizeKey = book.text_size || 'medium';
  const showText = (mode !== 'wordless') && page.page_text && page.page_text.trim().length > 0;

  // Resolve text size
  const sizeBucket = TEXT_SIZE_MAP[sizeKey] || TEXT_SIZE_MAP.medium;
  let textSize = sizeBucket[mode === 'picture' ? 'picture' : (mode === 'comic' ? 'comic' : 'story')];

  // Handwritten font reads slightly larger and benefits from generous line height.
  const isHandwritten = book.text_font === 'caveat';
  if (isHandwritten) textSize = Math.round(textSize * 1.1);

  const textFont = fonts.body;
  const lineHeight = textSize * (isHandwritten ? 1.55 : 1.4);
  const blockWidth = w - 2 * margin;

  // Pre-wrap text so we know how much vertical room it needs
  let textLines = [];
  let textBlockHeight = 0;
  if (showText) {
    textLines = wrapLines(textFont, page.page_text.trim(), textSize, blockWidth);
    textBlockHeight = textLines.length * lineHeight + 8; // small bottom pad
  }

  // Image region
  const reservedForFooter = 22;
  const availableH = h - 2 * margin - reservedForFooter;
  const imgMaxH = showText ? Math.max(80, availableH - textBlockHeight - 14) : availableH;
  const imgMaxW = w - 2 * margin;

  let imgDrawn = false;
  let imgBottomY = h - margin;
  if (page.storage_path) {
    const bytes = await getImageBytes(page.storage_path);
    if (bytes) {
      const isJpeg = /\.(jpe?g)$/i.test(page.storage_path);
      const embedded = await embedImage(pdfDoc, bytes, isJpeg ? 'image/jpeg' : 'image/png');
      if (embedded) {
        const ratio = embedded.width / embedded.height;
        let drawW = imgMaxW;
        let drawH = drawW / ratio;
        if (drawH > imgMaxH) {
          drawH = imgMaxH;
          drawW = drawH * ratio;
        }
        const x = (w - drawW) / 2;
        const y = h - margin - drawH;
        pdfPage.drawImage(embedded, { x, y, width: drawW, height: drawH });
        imgBottomY = y;
        imgDrawn = true;
      }
    }
  }
  if (!imgDrawn) {
    pdfPage.drawText('(no art on this page)', {
      x: margin, y: h - margin - 40,
      size: 11, font: fonts.body, color: rgb(0.6, 0.6, 0.6),
    });
    imgBottomY = h - margin - 60;
  }

  // Text block — start just under the image
  if (showText) {
    let cursor = imgBottomY - 14;
    // Make sure we don't run off the bottom; clamp top of text block to fit above footer
    const textBlockBottom = margin + reservedForFooter;
    const requiredTop = textBlockBottom + textBlockHeight;
    if (cursor < requiredTop) cursor = requiredTop;

    for (const line of textLines) {
      if (line === '') { cursor -= lineHeight * 0.5; continue; }
      const x = alignX(textFont, line, textSize, margin, blockWidth, align);
      pdfPage.drawText(line, { x, y: cursor, size: textSize, font: textFont, color: rgb(0.1, 0.1, 0.1) });
      cursor -= lineHeight;
    }
  }

  // Page number — centered, bottom. Use the body font (so handwritten books
  // get a handwritten page number too) at a slightly larger size for handwriting.
  const pn = String(page.page_order);
  const pnFont = textFont;
  const pnSize = isHandwritten ? 12 : 9;
  const pnX = alignX(pnFont, pn, pnSize, margin, blockWidth, 'center');
  pdfPage.drawText(pn, { x: pnX, y: 18, size: pnSize, font: pnFont, color: rgb(0.55, 0.55, 0.55) });
}

async function buildPdf(event) {
  const params = event.queryStringParameters || {};
  const bookId = params.book_id;
  const onePageId = params.page_id || null;
  const tokenFromQuery = params.token || null;

  if (!bookId) return jsonError(400, 'book_id required');

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '') || tokenFromQuery;
  if (!token) return jsonError(401, 'Authentication required');
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return jsonError(401, 'Invalid session');

  const { data: book, error: bookErr } = await supabase
    .from('story_worlds')
    .select('*')
    .eq('id', bookId)
    .eq('user_id', user.id)
    .single();
  if (bookErr || !book) return jsonError(404, 'Book not found');

  let pageQuery = supabase
    .from('story_world_pages')
    .select('*')
    .eq('book_id', bookId)
    .eq('user_id', user.id)
    .order('page_order', { ascending: true });
  if (onePageId) pageQuery = pageQuery.eq('id', onePageId);

  const { data: pages, error: pagesErr } = await pageQuery;
  if (pagesErr) return jsonError(500, 'Could not load pages: ' + pagesErr.message);
  if (!pages || !pages.length) return jsonError(404, 'No pages to print');

  const pdfDoc = await PDFDocument.create();
  const fonts = await loadFonts(pdfDoc, book.text_font || 'times');

  const pageWH = PAGE_SIZES[book.page_size] || PAGE_SIZES.letter;
  // Margin scales with page width — smaller pages get smaller margins
  const margin = Math.max(28, Math.round(pageWH[0] * 0.06));

  if (!onePageId) await drawTitlePage(pdfDoc, book, fonts, pageWH, margin);

  for (const p of pages) {
    await drawStoryPage(pdfDoc, p, book, fonts, pageWH, margin);
  }

  const pdfBytes = await pdfDoc.save();
  const safeTitle = (book.title || 'story-world').replace(/[^\w\-]+/g, '_').slice(0, 60);
  const filename = safeTitle + (onePageId ? '_page' : '') + '.pdf';

  // Netlify function responses are capped at 6 MB. Picture books with multiple
  // 1024x1024 images can easily exceed that, so we upload the PDF to Supabase
  // Storage and return a short-lived signed URL the browser can download from.
  const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const storagePath = user.id + '/' + book.id + '/_pdf/' + stamp + '_' + filename;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, Buffer.from(pdfBytes), { contentType: 'application/pdf', upsert: false });
  if (upErr) {
    return jsonError(500, 'Could not stash PDF: ' + upErr.message);
  }

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 3600, { download: filename }); // 1 hour, force attachment
  if (signErr || !signed?.signedUrl) {
    return jsonError(500, 'Could not sign PDF URL: ' + (signErr?.message || 'unknown'));
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ download_url: signed.signedUrl, filename, size_bytes: pdfBytes.length }),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return jsonError(405, 'Method not allowed');
  try {
    return await buildPdf(event);
  } catch (e) {
    console.error('[story-world-pdf] unhandled error:', e && e.stack || e);
    return jsonError(500, 'PDF build error: ' + (e && e.message || String(e)));
  }
};
