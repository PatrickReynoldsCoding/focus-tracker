#!/bin/sh
# Publishes site/ to the gh-pages branch (GitHub Pages serves it). Run from the repo root on a clean main.
set -e
tmp=$(mktemp -d)
git worktree add -f "$tmp" gh-pages 2>/dev/null || git worktree add -f --orphan -b gh-pages "$tmp"
rm -rf "$tmp"/* 
cp -R site/. "$tmp"/
touch "$tmp/.nojekyll"
(cd "$tmp" && git add -A && (git diff --cached --quiet || git commit -qm "Publish site") && git push origin gh-pages)
git worktree remove --force "$tmp"
