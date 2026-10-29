#!/usr/bin/env bash
# Fork (kokon-modal): sets the build's version everywhere the app reads it (for the build only, not
# committed): src-tauri/tauri.conf.json, package.json, package-lock.json and the workspace Cargo.toml.
#
#   bash scripts/release/set-version.sh 0.11.2017
set -euo pipefail
cd "$(dirname "$0")/../.."
version="$1"
for f in src-tauri/tauri.conf.json package.json package-lock.json; do
  node -e "
    const fs = require('fs'); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f));
    c.version = process.argv[2];
    if (c.packages && c.packages['']) c.packages[''].version = process.argv[2];
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
  " "$f" "$version"
done
# The first version line is the workspace's ([workspace.package]).
perl -0pi -e "s/^version = \"[^\"]*\"/version = \"$version\"/m" Cargo.toml
grep -n '^version' Cargo.toml | head -1
