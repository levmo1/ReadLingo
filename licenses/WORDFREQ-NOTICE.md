# wordfreq data notice

- Project: [rspeer/wordfreq](https://github.com/rspeer/wordfreq)
- Version used to generate the bundled lists: 3.1.1
- Generated files: `core.txt`, `intermediate.txt`, `advanced.txt`, `extended.txt`
- Data license: Creative Commons Attribution-ShareAlike 4.0 International
  (CC BY-SA 4.0)
- Code license of the upstream package: Apache-2.0; the upstream package code
  itself is not bundled in the Android app.

ReadLingo generated four lists with [`tools/generate-wordbooks.py`](../tools/generate-wordbooks.py)
by calling `top_n_list('en', 24000)`, retaining
the first 8000 unique lowercase alphabetic words, and splitting them into four
2000-word tiers. The generated data is distributed with attribution under
CC BY-SA 4.0. The complete license text is in
[`CC-BY-SA-4.0.txt`](CC-BY-SA-4.0.txt).

The lists are general English frequency tiers. They are not official CET4,
CET6, TOEFL or IELTS lists and must not be marketed as such.
