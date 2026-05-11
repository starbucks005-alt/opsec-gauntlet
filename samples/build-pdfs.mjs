import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
console.log('DIR =', DIR);

const titles = [
  { file: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
  { file: 'sherlock-holmes',      title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle' },
  { file: 'frankenstein',         title: 'Frankenstein',                       author: 'Mary Shelley' },
  { file: 'great-gatsby',         title: 'The Great Gatsby',                   author: 'F. Scott Fitzgerald' },
];

function trimGutenberg(raw){
  // Strip Gutenberg boilerplate header + footer.
  const start = raw.search(/\*\*\* START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/);
  const end   = raw.search(/\*\*\* END OF (THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/);
  let body = raw;
  if (start >= 0) body = body.slice(body.indexOf('\n', start) + 1);
  if (end > 0)    body = body.slice(0, body.indexOf('*** END OF', end - body.length + body.indexOf('*** END OF')));
  // Recompute end on trimmed body
  const endIdx = body.search(/\*\*\* END OF (THE|THIS) PROJECT GUTENBERG/);
  if (endIdx > 0) body = body.slice(0, endIdx);
  return body.trim();
}

for (const t of titles) {
  const txtPath = path.join(DIR, t.file + '.txt');
  const pdfPath = path.join(DIR, t.file + '.pdf');
  if (!fs.existsSync(txtPath)) { console.log('skip (no txt):', t.file); continue; }
  const raw = fs.readFileSync(txtPath, 'utf8');
  const body = trimGutenberg(raw);

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    info: { Title: t.title, Author: t.author, Subject: 'Sample manuscript for Greylander Press tools', Keywords: 'sample, public domain' },
  });
  doc.pipe(fs.createWriteStream(pdfPath));

  // Title page
  doc.font('Times-Bold').fontSize(28).text(t.title, { align: 'center' });
  doc.moveDown(0.5);
  doc.font('Times-Italic').fontSize(14).text(t.author, { align: 'center' });
  doc.moveDown(2);
  doc.font('Times-Roman').fontSize(10).fillColor('#666').text(
    'Public-domain sample manuscript provided by Greylander Press for the AI tools demo.\nSource text via Project Gutenberg.',
    { align: 'center' }
  );
  doc.fillColor('black');
  doc.addPage();

  // Body — paragraph by paragraph
  doc.font('Times-Roman').fontSize(11);
  const paragraphs = body.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  for (const p of paragraphs) {
    doc.text(p, { align: 'justify', paragraphGap: 6, lineGap: 1 });
  }

  doc.end();
  console.log('wrote', pdfPath);
}
