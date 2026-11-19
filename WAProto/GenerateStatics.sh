#!/bin/sh
# Regenerate WAProto/index.js + index.d.ts from WAProto.proto.
#
# TOOLCHAIN PIN (AunuBaileys 2.3.0 regen): protobufjs-cli@1.2.0 +
# protobufjs@7.5.4, both pinned EXACTLY. Do NOT relax this:
# - a bare `npx -y pbjs` resolves the unrelated npm package `pbjs`
#   (different CLI: `error: unknown option '-t'`), leaving nothing
#   generated;
# - protobufjs-cli 2.x / protobufjs 8 output calls Reader.tag(), which
#   does not exist in this tree's protobufjs ^7.6.5 runtime — every
#   proto.*.decode then throws `r.tag is not a function`;
# - letting the CLI float to protobufjs 7.6.x changes the generated
#   code (recursion-depth guards) versus the 7.5.4 output this tree
#   was verified against.
# The CLI is installed into a throwaway dir (not a devDependency — P9
# dependency diet) and discarded afterwards.
#
# WhatsApp's .proto uses `required` labels in a proto3 file, which the
# protobufjs 7 parser rejects. patch-protobufjs-parser.js (vendored
# from @wppconnect/wa-proto, Apache-2.0 — see its header) relaxes that
# guard in the pinned copy only; the .proto keeps the labels verbatim.
set -e
cd "$(dirname "$0")"

TOOLS_DIR="$(mktemp -d)"
trap 'rm -rf "$TOOLS_DIR"' EXIT INT TERM
npm install --prefix "$TOOLS_DIR" --no-save --no-audit --no-fund protobufjs-cli@1.2.0 protobufjs@7.5.4 >/dev/null 2>&1
cp ./patch-protobufjs-parser.js "$TOOLS_DIR/patch-protobufjs-parser.js"
(cd "$TOOLS_DIR" && node patch-protobufjs-parser.js)

PBJS="$TOOLS_DIR/node_modules/.bin/pbjs"
PBTS="$TOOLS_DIR/node_modules/.bin/pbts"
"$PBJS" -t static-module --no-beautify -w es6 --no-bundle --no-delimited --no-verify --no-comments -o ./index.js ./WAProto.proto
"$PBJS" -t static-module --no-beautify -w es6 --no-bundle --no-delimited --no-verify ./WAProto.proto | "$PBTS" --no-comments -o ./index.d.ts -
node ./fix-imports.js
