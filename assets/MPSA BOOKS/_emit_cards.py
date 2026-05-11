"""Emit static HTML for MPSA catalog cards."""
DRIVE = "https://drive.google.com/drive/folders/1clkeM9VdOPuD2lkpyckuYYAtiNtI4TPO?usp=sharing"

# Each entry: (folder, basename, display_title, num_label)
COMPANION = [
    ("COMPANION", "ANALYST_Book1_AnalystRibbon",            "Analyst",         "Book 1"),
    ("COMPANION", "PROFILER_Book2_Profiler Ribbon",         "Profiler",        "Book 2"),
    ("COMPANION", "SENTINEL_Book3_SentinelRibbon",          "Sentinel",        "Book 3"),
    ("COMPANION", "STRATEGIST_Book4_StrategistRibbon",      "Strategist",      "Book 4"),
    ("COMPANION", "DIPLOMAT_Book5_DiplomatRibbon",          "Diplomat",        "Book 5"),
    ("COMPANION", "HANDLER_Book6_HandlerRibbon",            "Handler",         "Book 6"),
    ("COMPANION", "TACTICIAN_Book7_TacticianRibbon",        "Tactician",       "Book 7"),
    ("COMPANION", "GUARDIAN_Book8_GuardianRibbon",          "Guardian",        "Book 8"),
    ("COMPANION", "GHOST_Book9_GhostRibbon",                "Ghost",           "Book 9"),
    ("COMPANION", "FIELD_COMMANDER_Book10_FieldCommanderRibbon", "Field Commander", "Book 10"),
]
FICTION = [
    ("FICTION", "MPSA_Fiction_Book1_The_Read",   "The Read",   "Book 1"),
    ("FICTION", "MPSA_Fiction_Book2_The_Source", "The Source", "Book 2"),
    ("FICTION", "MPSA_Fiction_Book3_The_Ghost",  "The Ghost",  "Book 3"),
    ("FICTION", "MPSA_Fiction_Book4_The_Table",  "The Table",  "Book 4"),
    ("FICTION", "MPSA_Fiction_Book5_The_Watch",  "The Watch",  "Book 5"),
]
HANDBOOKS = [
    ("HANDBOOKS", "Handbook_1_THE_READER", "The Reader", "Handbook 1", False),
    ("HANDBOOKS", "Handbook_2_THE_SCOUT",  "The Scout",  "Handbook 2", False),
    ("HANDBOOKS", "Handbook_3_THE_EDGE",   "The Edge",   "Handbook 3", True),   # 115 MB → Drive
    ("HANDBOOKS", "Handbook_4_THE_ENVOY",  "The Envoy",  "Handbook 4", True),   # 73  MB → Drive
    ("HANDBOOKS", "Handbook_5_THE_SHADOW", "The Shadow", "Handbook 5", False),
]

def card(folder, basename, title, num, series_label, use_drive=False):
    cover = f"assets/MPSA BOOKS/covers/{basename}.jpg"
    pdf   = f"assets/MPSA BOOKS/{folder}/{basename}.pdf"
    href  = DRIVE if use_drive else pdf
    link_text = "Download from Drive" if use_drive else "Download PDF"
    target = ' target="_blank" rel="noopener"' if use_drive else ""
    dl_attr = "" if use_drive else " download"
    return f'''        <div class="book-card" data-cover="{cover}">
          <div class="book-genre">{series_label} · {num}</div>
          <div class="book-title">{title}</div>
          <div class="book-author">MPSA</div>
          <div class="book-formats"><span class="format-tag">PDF</span></div>
          <a class="book-amazon" href="{href}"{target}{dl_attr}>{link_text}</a>
        </div>'''

print('    <h3 class="section-subtitle" style="font-family:\'Playfair Display\',serif;font-size:1.3rem;font-style:italic;color:var(--cream);margin-top:2.5rem;margin-bottom:1rem;">Companion Workbooks</h3>')
print('    <div class="book-grid">')
for f, b, t, n in COMPANION:
    print(card(f, b, t, n, "MPSA Women's Operative Series · Companion"))
print('    </div>')

print()
print('    <h3 class="section-subtitle" style="font-family:\'Playfair Display\',serif;font-size:1.3rem;font-style:italic;color:var(--cream);margin-top:2.5rem;margin-bottom:1rem;">Fiction</h3>')
print('    <div class="book-grid">')
for f, b, t, n in FICTION:
    print(card(f, b, t, n, "MPSA Women's Operative Series · Fiction"))
print('    </div>')

print()
print('    <h3 class="section-subtitle" style="font-family:\'Playfair Display\',serif;font-size:1.3rem;font-style:italic;color:var(--cream);margin-top:2.5rem;margin-bottom:1rem;">Handbooks</h3>')
print('    <div class="book-grid">')
for f, b, t, n, use_drive in HANDBOOKS:
    print(card(f, b, t, n, "MPSA Women's Operative Series · Handbook", use_drive))
print('    </div>')
