"""One-off: render first page of every MPSA PDF to a JPG cover (~600px wide)."""
import sys
from pathlib import Path
import fitz

ROOT = Path(__file__).parent
OUT = ROOT / "covers"
OUT.mkdir(exist_ok=True)

TARGET_WIDTH = 600

pdfs = sorted(ROOT.glob("*/*.pdf"))
print(f"Found {len(pdfs)} PDFs")

for pdf_path in pdfs:
    out_path = OUT / (pdf_path.stem + ".jpg")
    if out_path.exists():
        print(f"  skip (exists): {out_path.name}")
        continue
    try:
        doc = fitz.open(pdf_path)
        page = doc[0]
        page_w = page.rect.width
        zoom = TARGET_WIDTH / page_w
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        pix.save(str(out_path), jpg_quality=82)
        doc.close()
        size_kb = out_path.stat().st_size // 1024
        print(f"  rendered: {out_path.name} ({pix.width}x{pix.height}, {size_kb} KB)")
    except Exception as e:
        print(f"  ERROR on {pdf_path.name}: {e}", file=sys.stderr)

print("Done.")
