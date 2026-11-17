# Stem Sync

Player de stems sincronizadas que roda no navegador (Linux, macOS e iPhone). Abra em https://augustobob.github.io/stem-sync/

- Velocidade de 0,5× a 1,5× **sem mudar o tom**, e tom de −12 a +12 semitons, independentes.
- Todas as stems passam por um único processador (AudioWorklet), então ficam sempre sincronizadas.
- Biblioteca no menu ☰: cada música é uma pasta salva **só neste aparelho** (IndexedDB). Nada é enviado para servidor.
- Instalável como app (PWA) e funciona offline.

## Arquivos

- `index.html`, `css/app.css`, `js/app.js` (interface), `js/engine.js` (motor de áudio), `js/db.js` (biblioteca), `js/tags.js` (nome sugerido pelas tags)
- `js/stem-processor.js`: gerado por `tools/build-worklet.sh` a partir de `tools/stem-processor.src.js` + Signalsmith Stretch
- `sw.js` (offline), `manifest.webmanifest`. Os ícones vão embutidos como data: URI no `index.html` e no manifest (gerados por `tools/embed-icons.py`).

## Licenças de terceiros

- [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) 1.3.2 (pacote npm `signalsmith-stretch`), © 2022 Geraint Luff / Signalsmith Audio Ltd., licença MIT. Cópia em `lib/signalsmith-stretch/` com `LICENSE.txt`.
