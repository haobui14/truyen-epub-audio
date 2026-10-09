# TruyệnAudio — Story Flame

The selected first logo combines turning pages with a rising flame. Jade
`#69c7a2`, ivory `#f2eee4`, and ink `#0d1117` match the approved concept.

The clean production master is `frontend/public/brand/story-flame.svg`.
The header uses this master directly. Web/PWA icons, Apple touch icon,
favicons, Android launcher assets, and splash screens derive from it.

Regenerate from `frontend/` with `pnpm brand:assets`.

Normal icons use a larger mark; maskable PWA icons and Android adaptive
foregrounds keep the complete flame inside the central safe circle.
Icon metadata uses `?v=story-flame-1` to refresh older cached artwork.

The concept was created with the built-in image generation tool, then recreated
as four smooth vector shapes to keep small-size edges and transparent gaps clean.
`story-flame-reference.png` preserves the generated reference.

The full production isolation prompt used with the built-in image generation
tool is saved in [story-flame.prompt.md](story-flame.prompt.md).
