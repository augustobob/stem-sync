#!/bin/sh
# Gera js/stem-processor.js = fábrica WASM do Signalsmith Stretch (linhas 3-16 do .mjs oficial) + nosso processador
cd "$(dirname "$0")/.."
{
  echo "/* Gerado por tools/build-worklet.sh. Signalsmith Stretch (c) 2022 Geraint Luff / Signalsmith Audio Ltd., licença MIT: lib/signalsmith-stretch/LICENSE.txt */"
  sed -n '3,16p' lib/signalsmith-stretch/SignalsmithStretch.mjs
  cat tools/stem-processor.src.js
} > js/stem-processor.js
