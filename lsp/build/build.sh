#!/bin/bash
set -euo pipefail

rm -rf dist

node --loader ts-node/esm --loader ../register.mjs build/build.civet

mkdir dist/lib
cp node_modules/typescript/lib/lib.*.d.ts dist/lib
