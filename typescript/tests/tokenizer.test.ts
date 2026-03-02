import { describe, it, expect } from "vitest";
import { tokenize, tokenizeWithMeta, isKeyValue, isCellRange, parseKeyValue, parseKeyValueWithMeta, isArrow, isSelector } from "../src/tokenizer.js";

describe("tokenize", () => {
  it("splits simple tokens", () => {
    expect(tokenize("add svc AuthService")).toEqual(["add", "svc", "AuthService"]);
  });

  it("handles quoted strings", () => {
    expect(tokenize('add svc "Auth Service" theme:blue')).toEqual([
      "add", "svc", "Auth Service", "theme:blue",
    ]);
  });

  it("handles escaped quotes inside quoted strings", () => {
    expect(tokenize('label A "say \\"hello\\""')).toEqual([
      "label", "A", 'say "hello"',
    ]);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("handles whitespace-only input", () => {
    expect(tokenize("   ")).toEqual([]);
  });

  it("handles multiple spaces between tokens", () => {
    expect(tokenize("add   svc   A")).toEqual(["add", "svc", "A"]);
  });

  it("converts literal \\n to newline in unquoted tokens", () => {
    expect(tokenize("add svc Container\\nRegistry")).toEqual([
      "add", "svc", "Container\nRegistry",
    ]);
  });

  it("converts literal \\n to newline in quoted strings", () => {
    expect(tokenize('add svc "Container\\nRegistry"')).toEqual([
      "add", "svc", "Container\nRegistry",
    ]);
  });

  it("handles embedded quoted values (key:\"value\") — preserves quotes in token", () => {
    expect(tokenize('label:"Line1\\nLine2"')).toEqual(['label:"Line1\nLine2"']);
  });

  it("parseKeyValue strips preserved quotes for backwards compat", () => {
    const { key, value } = parseKeyValue('label:"Line1\nLine2"');
    expect(key).toBe("label");
    expect(value).toBe("Line1\nLine2");
  });

  it("parseKeyValueWithMeta reports wasQuoted flag", () => {
    const result = parseKeyValueWithMeta('engine_version:"15"');
    expect(result.key).toBe("engine_version");
    expect(result.value).toBe("15");
    expect(result.wasQuoted).toBe(true);
  });

  it("parseKeyValueWithMeta reports wasQuoted=false for unquoted", () => {
    const result = parseKeyValueWithMeta("port:80");
    expect(result.key).toBe("port");
    expect(result.value).toBe("80");
    expect(result.wasQuoted).toBe(false);
  });

  it("converts multiple \\n sequences", () => {
    expect(tokenize("add svc A\\nB\\nC")).toEqual(["add", "svc", "A\nB\nC"]);
  });

  it("handles single token", () => {
    expect(tokenize("add")).toEqual(["add"]);
  });

  it("handles empty quoted string", () => {
    expect(tokenize('""')).toEqual([""]);
  });

  it("handles unclosed quote (takes rest as token)", () => {
    expect(tokenize('"hello world')).toEqual(["hello world"]);
  });

  it("handles escaped backslash in quotes", () => {
    expect(tokenize('"path\\\\dir"')).toEqual(["path\\dir"]);
  });

  it("handles key:value with colons in value", () => {
    expect(tokenize("url:http://example.com")).toEqual(["url:http://example.com"]);
  });

  it("handles unicode escape \\uXXXX in quoted strings", () => {
    expect(tokenize('"em dash \\u2014 here"')).toEqual(["em dash \u2014 here"]);
  });

  it("handles unicode escape \\uXXXX at start of quoted string", () => {
    expect(tokenize('"\\u00A9 2026"')).toEqual(["\u00A9 2026"]);
  });

  it("passes through invalid unicode escape literally", () => {
    expect(tokenize('"\\u00GZ"')).toEqual(["\\u00GZ"]);
  });

  it("handles unicode escape \\uXXXX in unquoted tokens", () => {
    expect(tokenize("Copyright\\u00A92026")).toEqual(["Copyright\u00A92026"]);
  });
});

describe("isKeyValue", () => {
  it("returns true for key:value", () => {
    expect(isKeyValue("theme:blue")).toBe(true);
  });

  it("returns true for key:value with colons in value", () => {
    expect(isKeyValue("url:http://x")).toBe(true);
  });

  it("returns false for selectors", () => {
    expect(isKeyValue("@type:db")).toBe(false);
  });

  it("returns false for arrows", () => {
    expect(isKeyValue("->")).toBe(false);
  });

  it("returns false for plain words", () => {
    expect(isKeyValue("hello")).toBe(false);
  });

  it("returns false for trailing colon", () => {
    expect(isKeyValue("key:")).toBe(false);
  });

  it("returns false for leading colon", () => {
    expect(isKeyValue(":value")).toBe(false);
  });

  // Cell range exclusions — ranges must NOT be treated as key:value
  it("returns false for cell range A1:F1", () => {
    expect(isKeyValue("A1:F1")).toBe(false);
  });

  it("returns false for cell range AA1:BB23", () => {
    expect(isKeyValue("AA1:BB23")).toBe(false);
  });

  it("returns false for row range 3:3", () => {
    expect(isKeyValue("3:3")).toBe(false);
  });

  it("returns false for row range 1:5", () => {
    expect(isKeyValue("1:5")).toBe(false);
  });

  it("returns false for cross-sheet range Sheet2!A1:B10", () => {
    expect(isKeyValue("Sheet2!A1:B10")).toBe(false);
  });

  it("returns false for formulas =SUM(D2:D4)", () => {
    expect(isKeyValue("=SUM(D2:D4)")).toBe(false);
  });

  it("returns false for formula =AVERAGE(B2:B4)", () => {
    expect(isKeyValue("=AVERAGE(B2:B4)")).toBe(false);
  });

  it("returns false for simple formula =A1+B1", () => {
    expect(isKeyValue("=A1+B1")).toBe(false);
  });

  // Ensure legitimate key:value still works
  it("still recognizes at:1.1 as key:value", () => {
    expect(isKeyValue("at:1.1")).toBe(true);
  });

  it("still recognizes dur:quarter as key:value", () => {
    expect(isKeyValue("dur:quarter")).toBe(true);
  });

  it("still recognizes theme:blue as key:value", () => {
    expect(isKeyValue("theme:blue")).toBe(true);
  });

  it("still recognizes fmt:$#,##0 as key:value", () => {
    expect(isKeyValue("fmt:$#,##0")).toBe(true);
  });

  it("still recognizes vel:mf as key:value", () => {
    expect(isKeyValue("vel:mf")).toBe(true);
  });

  it("still recognizes by:A as key:value", () => {
    expect(isKeyValue("by:A")).toBe(true);
  });
});

describe("isCellRange", () => {
  it("recognizes cell ranges like A1:F1", () => {
    expect(isCellRange("A1:F1")).toBe(true);
  });

  it("recognizes multi-char column cell ranges like AA1:BB23", () => {
    expect(isCellRange("AA1:BB23")).toBe(true);
  });

  it("recognizes row ranges like 3:3", () => {
    expect(isCellRange("3:3")).toBe(true);
  });

  it("recognizes row span ranges like 1:5", () => {
    expect(isCellRange("1:5")).toBe(true);
  });

  it("recognizes cross-sheet ranges like Sheet2!A1:B10", () => {
    expect(isCellRange("Sheet2!A1:B10")).toBe(true);
  });

  it("does not recognize pure column ranges (ambiguous with key:value)", () => {
    // Column ranges like A:E are ambiguous with key:value (theme:blue, vel:mf)
    // They should be handled at the domain level or use hyphen syntax (A-E)
    expect(isCellRange("A:E")).toBe(false);
    expect(isCellRange("B:B")).toBe(false);
  });

  it("rejects key:value patterns like theme:blue", () => {
    expect(isCellRange("theme:blue")).toBe(false);
  });

  it("rejects key:value with hash like fill:#ff0000", () => {
    expect(isCellRange("fill:#ff0000")).toBe(false);
  });

  it("rejects plain words", () => {
    expect(isCellRange("hello")).toBe(false);
  });

  it("rejects mixed patterns like at:1.1", () => {
    expect(isCellRange("at:1.1")).toBe(false);
  });
});

describe("parseKeyValue", () => {
  it("parses simple key:value", () => {
    expect(parseKeyValue("theme:blue")).toEqual({ key: "theme", value: "blue" });
  });

  it("parses value with colons", () => {
    expect(parseKeyValue("url:http://x:8080")).toEqual({ key: "url", value: "http://x:8080" });
  });
});

describe("isArrow", () => {
  it("recognizes ->", () => {
    expect(isArrow("->")).toBe(true);
  });

  it("recognizes <->", () => {
    expect(isArrow("<->")).toBe(true);
  });

  it("recognizes --", () => {
    expect(isArrow("--")).toBe(true);
  });

  it("rejects other tokens", () => {
    expect(isArrow("=>")).toBe(false);
    expect(isArrow("add")).toBe(false);
  });
});

describe("isSelector", () => {
  it("recognizes @-prefixed tokens", () => {
    expect(isSelector("@type:db")).toBe(true);
    expect(isSelector("@all")).toBe(true);
    expect(isSelector("@recent:5")).toBe(true);
  });

  it("rejects non-@ tokens", () => {
    expect(isSelector("type:db")).toBe(false);
    expect(isSelector("add")).toBe(false);
  });
});

describe("tokenizeWithMeta", () => {
  it("flags quoted strings with wasQuoted", () => {
    const result = tokenizeWithMeta('set A1 "LTV:CAC"');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ text: "set", wasQuoted: false });
    expect(result[1]).toEqual({ text: "A1", wasQuoted: false });
    expect(result[2]).toEqual({ text: "LTV:CAC", wasQuoted: true });
  });

  it("marks unquoted tokens as wasQuoted=false", () => {
    const result = tokenizeWithMeta("add svc AuthService");
    expect(result).toHaveLength(3);
    expect(result.every(t => !t.wasQuoted)).toBe(true);
  });

  it("handles key:value as unquoted", () => {
    const result = tokenizeWithMeta("style Node fill:#ff0000");
    expect(result[2]).toEqual({ text: "fill:#ff0000", wasQuoted: false });
  });

  it("handles mixed quoted and unquoted", () => {
    const result = tokenizeWithMeta('set A11 "LTV:CAC" fmt:$#,##0');
    expect(result[2]).toEqual({ text: "LTV:CAC", wasQuoted: true });
    expect(result[3]).toEqual({ text: "fmt:$#,##0", wasQuoted: false });
  });

  it("text roundtrip matches tokenize", () => {
    const op = 'connect "Auth Service" -> UserDB label:queries';
    const metaTexts = tokenizeWithMeta(op).map(t => t.text);
    const plainTexts = tokenize(op);
    expect(metaTexts).toEqual(plainTexts);
  });

  it("handles unicode escape in quoted strings", () => {
    const result = tokenizeWithMeta('"\\u00A9 2026"');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ text: "\u00A9 2026", wasQuoted: true });
  });
});
