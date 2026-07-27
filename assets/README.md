# assets

`hero.png` is the README banner. It is **generated**, not hand-drawn — the source is
`hero.html` in this directory, so every number on it stays traceable to
[`../benchmark/RESULTS.md`](../benchmark/RESULTS.md) and [`../EVAL.md`](../EVAL.md).

Regenerate after editing `hero.html`:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --force-device-scale-factor=2 \
  --default-background-color=00000000 --hide-scrollbars \
  --screenshot=assets/hero.png --window-size=1200,800 \
  "file://$PWD/assets/hero.html"

npx pngquant-bin --quality=70-92 --strip -f -o assets/hero.png assets/hero.png
```

Any headless Chromium works. Match `--window-size` to the `width`/`height` in `hero.html`,
or you get letterboxing; the scale factor sets output resolution (2 → 2400×1600).

## The mobile constraint — this is the whole design brief

The design canvas is **1200px wide on purpose**. GitHub renders a README image at roughly
**375px** on a phone, so everything in `hero.html` is divided by **~3.2** for most readers.

That sets a hard floor: **nothing below ~26px**, and body text wants 32px+. A 14px label —
perfectly normal in a web page — lands at 4px on a phone and is simply gone. An earlier
version of this banner was 1600px wide with 14–18px text and was unreadable on mobile.

The consequence: **fewer elements at a larger size beats more elements at a smaller one.**
When something new has to go on the banner, something else comes off.

Check before committing — downscale to phone width and actually look at it:

```bash
sips -Z 375 assets/hero.png --out /tmp/hero-mobile.png
```

Keep the file under ~120 KB. It is the first thing a visitor loads.

## Don't let the chart lie

The winning bar's `width:1.73%` is `4451 / 257778` — the real ratio, drawn to scale. If the
benchmark numbers change, that width changes with them.

## Packaging

Nothing here ships in the npm tarball (`assets/` is not in `package.json` `files`). npm
rewrites the README's relative image path against the `repository` field, so the banner
still renders on npmjs.com — but it resolves against the **default branch**, not the
published tag, so pushing a new banner changes it on already-published versions too.
