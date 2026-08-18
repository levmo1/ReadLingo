# Third-party license bundle

This directory contains the license texts and attribution notices for the
third-party files currently bundled with ReadLingo. ReadLingo's own source
code remains covered by the repository-level `LICENSE` file.

## Runtime libraries

| Bundled files | Upstream | License files |
| --- | --- | --- |
| `app/src/main/assets/libs/epub.min.js` | [futurepress/epub.js](https://github.com/futurepress/epub.js) | [`BSD-2-Clause.txt`](BSD-2-Clause.txt), [`EPUBJS-NOTICE.md`](EPUBJS-NOTICE.md) |
| `app/src/main/assets/libs/jszip.min.js` | [Stuk/JSZip](https://github.com/Stuk/jszip) 3.10.1 | [`MIT.txt`](MIT.txt), [`JSZIP-NOTICE.md`](JSZIP-NOTICE.md) |
| pako code bundled inside JSZip | [nodeca/pako](https://github.com/nodeca/pako) | [`MIT.txt`](MIT.txt), [`PAKO-NOTICE.md`](PAKO-NOTICE.md), [`ZLIB.txt`](ZLIB.txt) |

JSZip is dual-licensed under MIT or GPLv3. ReadLingo selects the MIT option;
the upstream dual-license text remains available in the JSZip repository.

## Fonts

The four bundled font families use the SIL Open Font License 1.1. The common
license text is [`OFL-1.1.txt`](OFL-1.1.txt); each notice file records the
copyright holder and upstream source:

- [`INTER-NOTICE.md`](INTER-NOTICE.md)
- [`LITERATA-NOTICE.md`](LITERATA-NOTICE.md)
- [`ATKINSON-HYPERLEGIBLE-NOTICE.md`](ATKINSON-HYPERLEGIBLE-NOTICE.md)
- [`SOURCE-SERIF-NOTICE.md`](SOURCE-SERIF-NOTICE.md)

## EPUB books

The three bundled books are Project Gutenberg editions. Their individual
headers contain the Project Gutenberg notice and ebook identifiers. The
the repository reference copy of the applicable terms is
[`PROJECT-GUTENBERG-LICENSE.md`](PROJECT-GUTENBERG-LICENSE.md), and the
per-book records are in [`PROJECT-GUTENBERG-BOOKS.md`](PROJECT-GUTENBERG-BOOKS.md).
The official Project Gutenberg page controls if the terms are updated.

Project Gutenberg rights are jurisdiction- and ebook-specific. Confirm the
notice inside each ebook before public or commercial redistribution.

## Word lists

The four bundled word lists are generated from `wordfreq` 3.1.1 and distributed
under CC BY-SA 4.0. The generation method and attribution are recorded in
[`WORDFREQ-NOTICE.md`](WORDFREQ-NOTICE.md), and the complete license text is in
[`CC-BY-SA-4.0.txt`](CC-BY-SA-4.0.txt).

They are general English frequency tiers, not official CET4, CET6, TOEFL or
IELTS lists. This avoids distributing source material whose public
redistribution rights are unclear and avoids making unsupported exam claims.
