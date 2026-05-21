# en.wiktionary.org-wiki-scx-han-page-text

Wiktionary page text for every Han-script character (Unicode `Script_Extensions=Han`), extracted from the English Wiktionary XML dump and shipped as per-character dynamic imports.

Each character maps to an async function that lazy-loads only the JSON bucket it lives in, so consumers pay for the characters they actually look up — not the entire dataset.

## Install

```bash
npm install en.wiktionary.org-wiki-scx-han-page-text
```

## Usage

```js
import wiktionaryPages from "en.wiktionary.org-wiki-scx-han-page-text";

const value = await wiktionaryPages["漢"]();
// value is either the raw wikitext (string) or a redirect target
// represented as a single-element tuple: [string].
```

### Return value shape

- `string` — the raw wikitext of that character's Wiktionary page.
- `[string]` — the page is a redirect; the array contains the normalized target title.

```ts
import type { WiktionaryPageValue } from "en.wiktionary.org-wiki-scx-han-page-text";
// WiktionaryPageValue = string | [string]
```

## How the data is generated

`scripts/parse.ts` streams the Wiktionary `pages-articles-multistream` dump, scans the index for titles whose every code point matches `\p{Script_Extensions=Han}`, decompresses only the bz2 sub-streams that contain those titles, and writes:

- `unicode/<hi-byte>xx.json` — bucketed page data, keyed by the high byte of each title's first code point.
- `index.js` / `index.d.ts` — the default-exported `wiktionaryPages` map of character → dynamic import.

To regenerate from a fresh dump:

```bash
node --experimental-strip-types scripts/parse.ts \
  path/to/enwiktionary-YYYYMMDD-pages-articles-multistream.xml.bz2 \
  path/to/enwiktionary-YYYYMMDD-pages-articles-multistream-index.txt.bz2
```

Requires `bzip2` on `PATH`.

## License

MIT
