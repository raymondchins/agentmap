# assets

`hero.png` is the README banner. It is **generated**, not hand-drawn — the source is
`hero.html` in this directory, so every number on it stays traceable to
[`../benchmark/RESULTS.md`](../benchmark/RESULTS.md) and [`../EVAL.md`](../EVAL.md).

Regenerate after editing `hero.html`:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --force-device-scale-factor=1.5 \
  --default-background-color=00000000 --hide-scrollbars \
  --screenshot=assets/hero.png --window-size=1600,516 \
  "file://$PWD/assets/hero.html"

npx pngquant-bin --quality=70-92 --strip -f -o assets/hero.png assets/hero.png
```

Any headless Chromium works; the scale factor is what sets the output resolution
(1.5 → 2400×774). Match `--window-size` to the `height` in `hero.html`, or you get letterboxing.
Keep the file under ~100 KB — it is the first thing a visitor loads.

The 1.73% width on the winning bar is `4451 / 257778` — if the benchmark numbers change,
that width has to change with them, or the chart lies.

Nothing here ships in the npm tarball (`assets/` is not in `package.json` `files`). npm
rewrites the README's relative image path against the `repository` field, so the banner
still renders on npmjs.com.
