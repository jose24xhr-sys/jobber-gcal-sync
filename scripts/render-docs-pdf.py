"""Render docs/*.md to styled PDFs with Chromium (Playwright) and build a combined kit."""
import re, sys, pathlib, datetime
import markdown
from playwright.sync_api import sync_playwright
from pypdf import PdfReader, PdfWriter

docs = pathlib.Path(sys.argv[1])
out = docs / "pdf"
out.mkdir(exist_ok=True)

FILES = [
    ("01-REQUIREMENTS.md", "Requirements"),
    ("02-REPLICATION-GUIDE.md", "Replication Guide"),
    ("03-OPERATIONS.md", "Operations & Troubleshooting"),
    ("04-AGENT-KICKOFF-PROMPT.md", "Agent Kickoff Prompt"),
]

CSS = """
@page { size: Letter; margin: 0.7in 0.65in 0.75in 0.65in; }
* { box-sizing: border-box; }
body { font-family: 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif; font-size: 9.6pt; line-height: 1.5; color: #1f2328; }
h1 { font-size: 19pt; margin: 0 0 4pt; color: #12372a; letter-spacing: -0.2pt; }
h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1.5px solid #cfe3d8; color: #12372a; break-after: avoid; }
h3 { font-size: 11pt; margin: 12pt 0 4pt; color: #1f4d3a; break-after: avoid; }
p { margin: 4pt 0 6pt; }
hr { border: 0; border-top: 1px solid #e3e6e8; margin: 12pt 0; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 8.6pt; break-inside: auto; }
tr { break-inside: avoid; }
th { background: #eef5f1; color: #12372a; text-align: left; font-weight: 700; }
th, td { border: 1px solid #d8dee2; padding: 4pt 6pt; vertical-align: top; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 8.2pt; background: #f3f5f7; padding: 0.5pt 3pt; border-radius: 3px; word-break: break-word; }
td code { word-break: normal; overflow-wrap: anywhere; }
td:first-child code { overflow-wrap: normal; }
pre { background: #f6f8fa; border: 1px solid #e1e5e9; border-radius: 6px; padding: 7pt 9pt; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 7.9pt; }
ul, ol { margin: 3pt 0 7pt; padding-left: 18pt; }
li { margin: 1.5pt 0; }
blockquote { margin: 6pt 0; padding: 4pt 10pt; border-left: 3px solid #2f6f4f; background: #f3f8f5; }
.tag { display: inline-block; font-size: 7pt; font-weight: 700; padding: 0.5pt 4pt; border-radius: 3px; vertical-align: 1px; }
.agent { background: #e3efff; color: #1849a9; }
.human { background: #fff1d6; color: #8a5300; }
.warn { background: #fde8e7; color: #a4251d; }
.cover { height: 9in; display: flex; flex-direction: column; justify-content: center; }
.cover h1 { font-size: 30pt; }
.cover .sub { font-size: 13pt; color: #4b5563; margin-top: 6pt; }
.cover .meta { margin-top: 36pt; font-size: 10pt; color: #4b5563; }
.cover ol { font-size: 11pt; margin-top: 18pt; }
"""

def prep(md: str) -> str:
    md = md.replace("🤖/👤", "AGENT_TAG/HUMAN_TAG").replace("🤖", "AGENT_TAG").replace("👤", "HUMAN_TAG").replace("⚠️", "WARN_TAG")
    md = md.replace("✅", "")
    # Python-Markdown needs 4-space indents for nested lists (docs use 3/5 for GitHub).
    md = re.sub(r"^     - ", "        - ", md, flags=re.M)
    md = re.sub(r"^   - ", "    - ", md, flags=re.M)
    md = re.sub(r"^   (?=\S)", "    ", md, flags=re.M)
    return md

def post(html: str) -> str:
    html = html.replace("AGENT_TAG", '<span class="tag agent">AGENT</span>')
    html = html.replace("HUMAN_TAG", '<span class="tag human">HUMAN</span>')
    html = html.replace("WARN_TAG", '<span class="tag warn">NOTE</span>')
    # checkbox list items
    html = html.replace("<li>[ ] ", "<li>&#9744; ").replace("<li>[x] ", "<li>&#9745; ")
    return html

def to_html(body: str, title: str) -> str:
    return f"<!doctype html><html><head><meta charset='utf-8'><title>{title}</title><style>{CSS}</style></head><body>{body}</body></html>"

today = datetime.date(2026, 10, 17).strftime("%B %d, %Y")
footer = f"""<div style="font-size:7pt;color:#6b7280;width:100%;padding:0 0.65in;display:flex;justify-content:space-between;font-family:Arial,sans-serif">
<span>Jobber → Google Calendar Sync · {{title}}</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>"""

made = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    for fname, title in FILES:
        md = prep((docs / fname).read_text())
        body = post(markdown.markdown(md, extensions=["tables", "fenced_code", "sane_lists"]))
        page.set_content(to_html(body, title), wait_until="load")
        target = out / fname.replace(".md", ".pdf")
        page.pdf(path=str(target), format="Letter", print_background=True, display_header_footer=True,
                 header_template="<div></div>", footer_template=footer.replace("{title}", title),
                 margin={"top": "0.6in", "bottom": "0.7in", "left": "0.65in", "right": "0.65in"})
        made.append(target)
    # cover
    cover = f"""<div class="cover"><div style="font-size:10pt;color:#2f6f4f;font-weight:700;letter-spacing:1pt">REPLICATION KIT</div>
<h1>Jobber → Google Calendar Sync</h1>
<div class="sub">Near real-time Jobber Job Visits on each estimator's Google Calendar, for Routemize availability and job stops.</div>
<ol><li>Requirements: accounts, resources, settings, secrets, cost</li><li>Replication Guide: phase-by-phase setup with verify checks</li>
<li>Operations &amp; Troubleshooting: daily tasks, fixes, behaviour</li><li>Agent Kickoff Prompt: paste into a new Claude agent</li></ol>
<div class="meta">Reference build: Cloudflare Worker <code>jobber-gcal-sync</code> · Repo <code>jose24xhr-sys/jobber-gcal-sync</code><br>Prepared {today}</div></div>"""
    page.set_content(to_html(cover, "Cover"), wait_until="load")
    cover_pdf = out / "_cover.pdf"
    page.pdf(path=str(cover_pdf), format="Letter", print_background=True, margin={"top": "0.6in", "bottom": "0.6in", "left": "0.8in", "right": "0.8in"})
    browser.close()

w = PdfWriter()
for f in [cover_pdf] + made:
    for pg in PdfReader(str(f)).pages:
        w.add_page(pg)
kit = out / "Jobber-GCal-Sync-Replication-Kit.pdf"
with open(kit, "wb") as fh:
    w.write(fh)
cover_pdf.unlink()
for f in made + [kit]:
    print(f.name, len(PdfReader(str(f)).pages), "pages")
