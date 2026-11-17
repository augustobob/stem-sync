#!/usr/bin/env python3
"""Os ícones vão embutidos como data: URI (index.html e manifest.webmanifest), porque o conector do GitHub
usado para publicar só envia texto. Rode depois de regerar icons/*.png (os PNGs ficam só no box)."""
import base64, json, re, os
os.chdir(os.path.join(os.path.dirname(__file__), ".."))
def d(f): return "data:image/png;base64," + base64.b64encode(open("icons/" + f, "rb").read()).decode()
s = open("index.html").read()
s = re.sub(r'(<link rel="apple-touch-icon" sizes="180x180" href=")[^"]*', lambda m: m.group(1) + d("apple-touch-icon.png"), s)
s = re.sub(r'(<link rel="icon" type="image/png" sizes="32x32" href=")[^"]*', lambda m: m.group(1) + d("favicon-32.png"), s)
open("index.html", "w").write(s)
m = json.load(open("manifest.webmanifest"))
for icon, f in zip(m["icons"], ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]): icon["src"] = d(f)
open("manifest.webmanifest", "w").write(json.dumps(m, ensure_ascii=False, indent=2) + "\n")
