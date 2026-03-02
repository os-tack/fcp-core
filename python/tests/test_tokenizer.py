"""Tests for fcp_core.tokenizer."""

import pytest

from fcp_core.tokenizer import (
    TokenMeta,
    is_arrow,
    is_key_value,
    is_selector,
    parse_key_value,
    tokenize,
    tokenize_with_meta,
)


class TestTokenize:
    def test_basic_splitting(self):
        assert tokenize("add svc AuthService") == ["add", "svc", "AuthService"]

    def test_double_quoted_string(self):
        assert tokenize('add svc "My Service" theme:blue') == [
            "add", "svc", "My Service", "theme:blue"
        ]

    def test_single_quoted_string(self):
        assert tokenize("add svc 'My Service' theme:blue") == [
            "add", "svc", "My Service", "theme:blue"
        ]

    def test_key_value_tokens(self):
        assert tokenize("style Node fill:#ff0000 bold") == [
            "style", "Node", "fill:#ff0000", "bold"
        ]

    def test_selector_tokens(self):
        assert tokenize("remove @type:db @all") == ["remove", "@type:db", "@all"]

    def test_arrows(self):
        assert tokenize("connect A -> B") == ["connect", "A", "->", "B"]

    def test_empty_string(self):
        assert tokenize("") == []

    def test_whitespace_only(self):
        assert tokenize("   ") == []

    def test_multiple_spaces(self):
        assert tokenize("add   svc   Name") == ["add", "svc", "Name"]

    def test_tabs(self):
        assert tokenize("add\tsvc\tName") == ["add", "svc", "Name"]

    def test_hash_not_comment(self):
        # # should NOT be treated as a comment character
        result = tokenize("style Node fill:#ff0000")
        assert "fill:#ff0000" in result

    def test_escaped_quote_in_string(self):
        # Single quotes inside double quotes don't need escaping
        result = tokenize('add svc "It\'s here"')
        assert result[2] == "It's here"

    def test_mixed_tokens(self):
        result = tokenize('connect "Auth Service" -> UserDB label:queries style:dashed')
        assert result == [
            "connect", "Auth Service", "->", "UserDB", "label:queries", "style:dashed"
        ]

    def test_escaped_double_quotes_in_quoted_string(self):
        # Backslash-escaped quotes inside double-quoted strings
        result = tokenize('label A "say \\"hello\\""')
        assert result == ["label", "A", 'say "hello"']

    def test_escaped_backslash_in_quoted_string(self):
        result = tokenize('"path\\\\dir"')
        assert result == ["path\\dir"]

    def test_backslash_n_in_quoted_string(self):
        result = tokenize('add svc "Container\\nRegistry"')
        assert result == ["add", "svc", "Container\nRegistry"]

    def test_backslash_n_in_unquoted_token(self):
        result = tokenize("add svc Container\\nRegistry")
        assert result == ["add", "svc", "Container\nRegistry"]

    def test_multiple_backslash_n(self):
        result = tokenize("add svc A\\nB\\nC")
        assert result == ["add", "svc", "A\nB\nC"]

    def test_if_formula_with_escaped_quotes(self):
        # This is the exact pattern that caused the Numbers crash
        result = tokenize('set H4 "=IF(G4>=1,\\"Exceeded\\",IF(G4>=0.9,\\"On Track\\",\\"At Risk\\"))"')
        assert result == ["set", "H4", '=IF(G4>=1,"Exceeded",IF(G4>=0.9,"On Track","At Risk"))']

    def test_backslash_n_in_embedded_quoted_value(self):
        result = tokenize('label:"Line1\\nLine2"')
        assert result == ['label:"Line1\nLine2"']

    def test_unicode_escape_in_quoted_string(self):
        assert tokenize('"em dash \\u2014 here"') == ["em dash \u2014 here"]

    def test_unicode_escape_at_start_of_quoted_string(self):
        assert tokenize('"\\u00A9 2026"') == ["\u00A9 2026"]

    def test_invalid_unicode_escape_passthrough(self):
        assert tokenize('"\\u00GZ"') == ["\\u00GZ"]

    def test_unicode_escape_in_unquoted_token(self):
        assert tokenize("Copyright\\u00A92026") == ["Copyright\u00A92026"]

    def test_unclosed_quote_raises(self):
        with pytest.raises(ValueError):
            tokenize('add svc "unclosed')


class TestIsKeyValue:
    def test_basic_key_value(self):
        assert is_key_value("theme:blue") is True

    def test_key_value_with_hash(self):
        assert is_key_value("fill:#ff0000") is True

    def test_selector_not_key_value(self):
        assert is_key_value("@track:Piano") is False

    def test_arrow_not_key_value(self):
        assert is_key_value("->") is False

    def test_plain_word(self):
        assert is_key_value("AuthService") is False

    def test_empty_value(self):
        assert is_key_value("key:") is True

    # Cell range exclusions — ranges must NOT be treated as key:value
    def test_cell_range_not_key_value(self):
        assert is_key_value("A1:F1") is False

    def test_cell_range_multichar_col(self):
        assert is_key_value("AA1:BB23") is False

    def test_row_range_not_key_value(self):
        assert is_key_value("3:3") is False

    def test_row_range_span(self):
        assert is_key_value("1:5") is False

    def test_cross_sheet_range_not_key_value(self):
        assert is_key_value("Sheet2!A1:B10") is False

    def test_formula_not_key_value(self):
        assert is_key_value("=SUM(D2:D4)") is False

    def test_formula_average_not_key_value(self):
        assert is_key_value("=AVERAGE(B2:B4)") is False

    def test_formula_simple_not_key_value(self):
        assert is_key_value("=A1+B1") is False

    # Ensure legitimate key:value still works
    def test_at_param_still_works(self):
        assert is_key_value("at:1.1") is True

    def test_dur_param_still_works(self):
        assert is_key_value("dur:quarter") is True

    def test_theme_param_still_works(self):
        assert is_key_value("theme:blue") is True

    def test_fmt_param_still_works(self):
        assert is_key_value("fmt:$#,##0") is True

    def test_vel_mf_still_key_value(self):
        assert is_key_value("vel:mf") is True

    def test_by_A_still_key_value(self):
        assert is_key_value("by:A") is True


class TestParseKeyValue:
    def test_basic(self):
        assert parse_key_value("theme:blue") == ("theme", "blue")

    def test_value_with_colon(self):
        # Only splits on first colon
        assert parse_key_value("fill:#ff0000") == ("fill", "#ff0000")

    def test_empty_value(self):
        assert parse_key_value("key:") == ("key", "")

    def test_multiple_colons(self):
        assert parse_key_value("a:b:c") == ("a", "b:c")

    def test_quoted_value_stripped(self):
        assert parse_key_value('title:"Score Chart"') == ("title", "Score Chart")

    def test_single_quoted_value_stripped(self):
        assert parse_key_value("title:'Score Chart'") == ("title", "Score Chart")


class TestIsSelector:
    def test_selector(self):
        assert is_selector("@track:Piano") is True

    def test_not_selector(self):
        assert is_selector("track:Piano") is False

    def test_at_all(self):
        assert is_selector("@all") is True


class TestIsArrow:
    def test_directed(self):
        assert is_arrow("->") is True

    def test_bidirectional(self):
        assert is_arrow("<->") is True

    def test_undirected(self):
        assert is_arrow("--") is True

    def test_not_arrow(self):
        assert is_arrow("connect") is False

    def test_partial_arrow(self):
        assert is_arrow("-") is False


class TestTokenizeWithMeta:
    def test_basic_tokens(self):
        result = tokenize_with_meta("add svc AuthService")
        assert len(result) == 3
        assert all(not t.was_quoted for t in result)
        assert result[0].text == "add"

    def test_quoted_string_flagged(self):
        result = tokenize_with_meta('set A1 "LTV:CAC"')
        assert len(result) == 3
        assert result[0] == TokenMeta(text="set", was_quoted=False)
        assert result[1] == TokenMeta(text="A1", was_quoted=False)
        assert result[2] == TokenMeta(text="LTV:CAC", was_quoted=True)

    def test_single_quoted_flagged(self):
        result = tokenize_with_meta("set A1 'LTV:CAC'")
        assert result[2].was_quoted is True
        assert result[2].text == "LTV:CAC"

    def test_key_value_not_quoted(self):
        result = tokenize_with_meta("style Node fill:#ff0000")
        assert result[2].was_quoted is False
        assert result[2].text == "fill:#ff0000"

    def test_mixed_quoted_and_unquoted(self):
        result = tokenize_with_meta('set A11 "LTV:CAC" fmt:$#,##0')
        assert result[2].was_quoted is True
        assert result[2].text == "LTV:CAC"
        assert result[3].was_quoted is False
        assert result[3].text == "fmt:$#,##0"

    def test_text_roundtrip_matches_tokenize(self):
        op = 'connect "Auth Service" -> UserDB label:queries'
        meta_texts = [t.text for t in tokenize_with_meta(op)]
        plain_texts = tokenize(op)
        assert meta_texts == plain_texts

    def test_unicode_escape_in_quoted_string(self):
        result = tokenize_with_meta('"\\u00A9 2026"')
        assert len(result) == 1
        assert result[0] == TokenMeta(text="\u00A9 2026", was_quoted=True)
