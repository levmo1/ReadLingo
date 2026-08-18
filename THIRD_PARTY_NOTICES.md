# Third-party notices

The MIT license in [`LICENSE`](LICENSE) applies only to ReadLingo's own
project code. It does not relicense bundled books, fonts, word lists or
third-party JavaScript libraries.

The full license texts and attribution records are collected in
[`licenses/`](licenses/README.md). This file is the short inventory shown at
the repository root.

## Runtime libraries

| Bundled path | Upstream | License | Repository notice |
| --- | --- | --- | --- |
| `app/src/main/assets/libs/epub.min.js` | [futurepress/epub.js](https://github.com/futurepress/epub.js) | BSD-2-Clause | [`licenses/EPUBJS-NOTICE.md`](licenses/EPUBJS-NOTICE.md) |
| `app/src/main/assets/libs/jszip.min.js` | [Stuk/JSZip](https://github.com/Stuk/jszip) 3.10.1 | MIT option of dual MIT/GPLv3 license | [`licenses/JSZIP-NOTICE.md`](licenses/JSZIP-NOTICE.md) |
| pako code bundled in JSZip | [nodeca/pako](https://github.com/nodeca/pako) | MIT + zlib | [`licenses/PAKO-NOTICE.md`](licenses/PAKO-NOTICE.md) |

## Fonts

All bundled fonts use SIL Open Font License 1.1. The shared full text is
[`licenses/OFL-1.1.txt`](licenses/OFL-1.1.txt); copyright and upstream records
are listed separately:

- [Inter notice](licenses/INTER-NOTICE.md)
- [Literata notice](licenses/LITERATA-NOTICE.md)
- [Atkinson Hyperlegible notice](licenses/ATKINSON-HYPERLEGIBLE-NOTICE.md)
- [Source Serif notice](licenses/SOURCE-SERIF-NOTICE.md)

## EPUB books

The bundled EPUBs are Project Gutenberg editions:

- [Alice's Adventures in Wonderland, #11](https://www.gutenberg.org/ebooks/11)
- [Pride and Prejudice, #1342](https://www.gutenberg.org/ebooks/1342)
- [Moby Dick; or The Whale, #2701](https://www.gutenberg.org/ebooks/2701)

Each EPUB contains its own Project Gutenberg header and license notice. The
book records and a repository reference copy of the applicable terms are in
[`licenses/PROJECT-GUTENBERG-BOOKS.md`](licenses/PROJECT-GUTENBERG-BOOKS.md)
and [`licenses/PROJECT-GUTENBERG-LICENSE.md`](licenses/PROJECT-GUTENBERG-LICENSE.md).
Check the exact notice in each ebook and the copyright law of the distribution
country before public or commercial redistribution.

## Word lists

The bundled word lists are generated from `wordfreq` 3.1.1:

- `core.txt`
- `intermediate.txt`
- `advanced.txt`
- `extended.txt`

The generated data is distributed under CC BY-SA 4.0. See
[`licenses/WORDFREQ-NOTICE.md`](licenses/WORDFREQ-NOTICE.md) and the complete
[`licenses/CC-BY-SA-4.0.txt`](licenses/CC-BY-SA-4.0.txt).

These are general English frequency tiers, not official CET4, CET6, TOEFL or
IELTS lists.
