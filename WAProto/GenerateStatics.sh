# pbjs/pbts come from the `protobufjs-cli` package, which is no longer a
# devDependency (P9 dependency diet) — fetch it on demand with npx when
# regenerating the protobuf statics.
npx -y pbjs -t static-module --no-beautify -w es6 --no-bundle --no-delimited --no-verify --no-comments -o ./index.js ./WAProto.proto;
npx -y pbjs -t static-module --no-beautify -w es6 --no-bundle --no-delimited --no-verify ./WAProto.proto | npx -y pbts --no-comments -o ./index.d.ts -;
node ./fix-imports.js
