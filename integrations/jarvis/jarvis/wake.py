"""The wake word: a configurable word ("adenine" by default) said at the start of an utterance.

Whisper hears a rare word in many ways ("Adonine", "a denine", "add an ain"), so the match is fuzzy:
the first one to three words, joined without spaces, must be within a small edit distance of the
wake word, or (for words of five letters or more) share its consonant skeleton at about its length.
One leading filler ("hey", "ok") is allowed. The words after the match are the command.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass

FILLERS = {"hey", "ok", "okay", "hi", "yo"}
_PUNCT_EDGES = " \t\n,.;:!?-–—…\"'“”‘’()[]"


def norm(word: str) -> str:
    """Lowercase letters and digits only (accents folded)."""
    w = unicodedata.normalize("NFKD", word.lower())
    return "".join(c for c in w if c.isalnum() and not unicodedata.combining(c))


def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def skeleton(s: str) -> str:
    """The first letter, then the consonants with repeats collapsed: 'addanain' and 'adenine' → 'adn'."""
    if not s:
        return s
    out = s[0]
    for c in s[1:]:
        if c in "aeiouy":
            continue
        if c != out[-1]:
            out += c
    return out


@dataclass(frozen=True)
class WakeMatch:
    wake: bool      # the wake word was heard at the start
    rest: str       # the utterance without it (the whole utterance when not heard)
    heard: str = "" # the words taken for the wake word


def _close(candidate: str, wake: str) -> tuple[int, int, int] | None:
    """A score (lower is closer) when `candidate` passes for `wake`, else None: edit-distance matches
    first, then the looser phonetic ones, each by distance and then by length difference."""
    d = levenshtein(candidate, wake)
    dl = abs(len(candidate) - len(wake))
    if d <= min(2, len(wake) // 3):
        return (0, d, dl)
    if len(wake) >= 5 and candidate[:1] == wake[:1] and dl <= 2 and skeleton(candidate) == skeleton(wake):
        return (1, d, dl)
    return None


def match(text: str, wake_word: str) -> WakeMatch:
    wake = norm(wake_word)
    words = text.split()
    if not wake or not words:
        return WakeMatch(False, text.strip())
    starts = [0]
    if norm(words[0]) in FILLERS and len(words) > 1:
        starts.append(1)
    best: tuple[tuple[int, int, int], int, int] | None = None  # (score, start, end)
    for s in starts:
        joined = ""
        for k in range(s, min(s + 3, len(words))):
            joined += norm(words[k])
            if not joined:
                continue
            score = _close(joined, wake)
            if score is not None and (best is None or score < best[0]):
                best = (score, s, k + 1)
    if best is None:
        return WakeMatch(False, text.strip())
    _, s, e = best
    rest = " ".join(words[e:]).lstrip(_PUNCT_EDGES).strip()
    return WakeMatch(True, rest, " ".join(words[s:e]).strip(_PUNCT_EDGES))
