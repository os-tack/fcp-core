"""Quote-aware tokenizer for FCP op strings.

Splits on whitespace but respects quoted strings (single and double quotes).
Handles embedded quotes in key:value tokens (e.g. ``title:"Score Chart"``).
Provides helpers for key:value token detection and parsing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_WHITESPACE = frozenset(" \t\n\r")


@dataclass
class TokenMeta:
    """A token with metadata about how it was originally written."""

    text: str
    was_quoted: bool


def _consume_quoted(s: str, i: int, quote_char: str) -> tuple[str, int]:
    """Consume characters until the matching *quote_char*, starting after it.

    Handles backslash escape sequences:
      ``\\"`` → literal ``"``   (escaped quote)
      ``\\n`` → newline
      ``\\\\`` → literal ``\\``
      ``\\x`` → literal ``x``  (any other char after backslash)

    Returns ``(content, new_index)`` where *content* excludes the delimiters.
    Raises :class:`ValueError` on unclosed quote.
    """
    n = len(s)
    i += 1  # skip opening quote
    buf: list[str] = []
    while i < n:
        ch = s[i]
        if ch == "\\" and i + 1 < n:
            nxt = s[i + 1]
            if nxt == "n":
                buf.append("\n")
                i += 2
            elif nxt == "u":
                # \uXXXX — read 4 hex digits
                hex_str = s[i + 2 : i + 6]
                if len(hex_str) == 4 and all(c in "0123456789abcdefABCDEF" for c in hex_str):
                    buf.append(chr(int(hex_str, 16)))
                    i += 6
                else:
                    # Invalid hex — pass through literally
                    buf.append("\\u")
                    i += 2
            else:
                # \" → " , \\ → \ , \x → x
                buf.append(nxt)
                i += 2
        elif ch == quote_char:
            return "".join(buf), i + 1  # skip closing quote
        else:
            buf.append(ch)
            i += 1
    raise ValueError("No closing quotation")


def tokenize_with_meta(op_string: str) -> list[TokenMeta]:
    """Split *op_string* on whitespace, respecting quoted substrings.

    Handles three quoting scenarios:

    1. **Standalone quotes** — token starts with ``"`` or ``'``.
       Quotes are stripped, ``was_quoted=True``.
       ``"LTV:CAC"`` → ``TokenMeta(text='LTV:CAC', was_quoted=True)``

    2. **Embedded quotes** — quote appears mid-token (e.g. after ``:``)
       in a ``key:"value with spaces"`` pattern.  The quotes are preserved
       in the token text so ``parse_key_value`` can strip them later.
       ``was_quoted=False``.
       ``title:"Score Chart"`` → ``TokenMeta(text='title:"Score Chart"', was_quoted=False)``

    3. **No quotes** — plain token, ``was_quoted=False``.

    Raises :class:`ValueError` on unclosed standalone quotes.
    """
    tokens: list[TokenMeta] = []
    i = 0
    n = len(op_string)

    while i < n:
        # Skip whitespace
        while i < n and op_string[i] in _WHITESPACE:
            i += 1
        if i >= n:
            break

        ch = op_string[i]

        if ch in ('"', "'"):
            # Standalone quoted string
            content, i = _consume_quoted(op_string, i, ch)
            tokens.append(TokenMeta(text=content, was_quoted=True))
        else:
            # Unquoted token — accumulate until whitespace, handling
            # embedded quotes (e.g. title:"Score Chart") as sub-regions
            buf: list[str] = []
            while i < n and op_string[i] not in _WHITESPACE:
                ch = op_string[i]
                if ch in ('"', "'"):
                    # Embedded quote — preserve delimiters in token text
                    buf.append(ch)
                    i += 1
                    while i < n and op_string[i] != ch:
                        if op_string[i] == "\\" and i + 1 < n:
                            nxt = op_string[i + 1]
                            if nxt == "n":
                                buf.append("\n")
                                i += 2
                            elif nxt == "u":
                                # \uXXXX — read 4 hex digits
                                hex_str = op_string[i + 2 : i + 6]
                                if len(hex_str) == 4 and all(
                                    c in "0123456789abcdefABCDEF" for c in hex_str
                                ):
                                    buf.append(chr(int(hex_str, 16)))
                                    i += 6
                                else:
                                    # Invalid hex — pass through literally
                                    buf.append("\\u")
                                    i += 2
                            else:
                                buf.append(nxt)
                                i += 2
                        else:
                            buf.append(op_string[i])
                            i += 1
                    if i < n:
                        buf.append(op_string[i])  # closing quote
                        i += 1
                else:
                    buf.append(ch)
                    i += 1
            # Convert literal \n and \uXXXX in unquoted tokens
            text = "".join(buf).replace("\\n", "\n")
            text = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), text)
            tokens.append(TokenMeta(text=text, was_quoted=False))

    return tokens


def tokenize(op_string: str) -> list[str]:
    """Split *op_string* on whitespace, respecting quoted substrings.

    Examples
    --------
    >>> tokenize('add svc "My Service" theme:blue')
    ['add', 'svc', 'My Service', 'theme:blue']
    >>> tokenize("add svc 'My Service' theme:blue")
    ['add', 'svc', 'My Service', 'theme:blue']
    """
    return [t.text for t in tokenize_with_meta(op_string)]


# Patterns for cell range detection (spreadsheet A1 notation).
# Cell ref: 1-3 letters followed by digits (e.g. A1, BB23, XFD1048576)
_CELL_REF_RE = re.compile(r"^[A-Za-z]{1,3}\d+$")
# Row ref: digits only (e.g. 1, 23)
_ROW_REF_RE = re.compile(r"^[0-9]+$")

# Note: Pure column ranges (A:E, B:B) are intentionally NOT detected here
# because they are ambiguous with key:value pairs like "theme:blue" or
# "vel:mf". Column-only ranges should use hyphen syntax (A-E) or be
# handled at the domain level.


def _is_cell_range(token: str) -> bool:
    """Return True if *token* looks like a spreadsheet cell range.

    Recognized patterns (with optional ``Sheet!`` prefix):
      A1:F1     — cell range (letters+digits : letters+digits)
      3:3       — row range (digits : digits)
      1:5       — row range
      Sheet2!A1:B10 — cross-sheet cell range

    NOT recognized (ambiguous with key:value):
      A:E       — column range (use A-E instead, or handle at domain level)
    """
    ref = token
    # Strip optional sheet prefix (Sheet2!A1:B10 → A1:B10)
    if "!" in ref:
        ref = ref.split("!", 1)[1]

    if ":" not in ref:
        return False

    left, right = ref.split(":", 1)
    if not left or not right:
        return False

    # Cell range: A1:F1 (most common spreadsheet range pattern)
    if _CELL_REF_RE.match(left) and _CELL_REF_RE.match(right):
        return True
    # Row range: 1:5 or 3:3 (no FCP key is ever a pure number)
    if _ROW_REF_RE.match(left) and _ROW_REF_RE.match(right):
        return True

    return False


def is_key_value(token: str) -> bool:
    """Return True if *token* is a ``key:value`` pair.

    A key:value token contains ``:``, does NOT start with ``@``
    (that is a selector), is not an arrow (``->``), is not a
    formula (starts with ``=``), and is not a spreadsheet cell
    range (e.g. ``A1:F1``, ``B:B``, ``3:3``).
    """
    if token.startswith("@"):
        return False
    if "->" in token:
        return False
    # Formulas (=SUM(A1:B2)) are values, not key:value pairs
    if token.startswith("="):
        return False
    # Spreadsheet cell ranges (A1:F1, B:B, 3:3) are positional args
    if _is_cell_range(token):
        return False
    return ":" in token


def parse_key_value(token: str) -> tuple[str, str]:
    """Split *token* on the first ``:`` and return ``(key, value)``."""
    key, _, value = token.partition(":")
    # Strip surrounding quotes preserved by posix=False tokenization
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        value = value[1:-1]
    return key, value


def is_selector(token: str) -> bool:
    """Return True if *token* is a selector (starts with ``@``)."""
    return token.startswith("@")


def is_arrow(token: str) -> bool:
    """Return True if *token* is an arrow (``->``, ``<->``, or ``--``)."""
    return token in ("->", "<->", "--")
