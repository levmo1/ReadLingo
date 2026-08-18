#!/usr/bin/env python3
"""Generate the bundled open wordbook tiers from wordfreq 3.1.1."""

from pathlib import Path
import re

from wordfreq import top_n_list


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "app/src/main/assets/wordbooks"

TIERS = [
    ("core.txt", "开放英语·核心词汇", 0, 2000),
    ("intermediate.txt", "开放英语·进阶词汇", 2000, 4000),
    ("advanced.txt", "开放英语·高阶词汇", 4000, 6000),
    ("extended.txt", "开放英语·扩展词汇", 6000, 8000),
]


def clean_words():
    words = []
    seen = set()
    for item in top_n_list("en", 24000):
        word = item.lower()
        if not re.fullmatch(r"[a-z]+", word) or len(word) < 2 or word in seen:
            continue
        seen.add(word)
        words.append(word)
        if len(words) >= 8000:
            break
    if len(words) < 8000:
        raise RuntimeError(f"only found {len(words)} clean English words")
    return words


def main():
    words = clean_words()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for filename, label, start, end in TIERS:
        lines = [
            f"# {label} · wordfreq 3.1.1 · CC BY-SA 4.0",
            "# One word per line; meanings are enriched at runtime.",
            *words[start:end],
        ]
        (OUTPUT / filename).write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"{filename}: {end - start} words")


if __name__ == "__main__":
    main()
