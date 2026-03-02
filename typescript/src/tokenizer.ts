/**
 * A token with metadata about how it was originally written.
 */
export interface TokenMeta {
  text: string;
  wasQuoted: boolean;
}

/**
 * Tokenize an operation string by whitespace, respecting quoted strings.
 * Returns structured tokens that preserve whether each token was originally quoted.
 *
 * This allows downstream code (e.g. parseOp) to skip key:value classification
 * for quoted tokens like "LTV:CAC".
 */
export function tokenizeWithMeta(input: string): TokenMeta[] {
  const tokens: TokenMeta[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && input[i] === " ") i++;
    if (i >= len) break;

    if (input[i] === '"') {
      // Quoted string
      i++; // skip opening quote
      let token = "";
      while (i < len && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < len) {
          const next = input[i + 1];
          if (next === "n") {
            token += "\n";
            i += 2;
          } else if (next === "u") {
            // \uXXXX — read 4 hex digits
            const hex = input.slice(i + 2, i + 6);
            if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
              token += String.fromCharCode(parseInt(hex, 16));
              i += 6;
            } else {
              // Invalid hex — pass through literally
              token += "\\u";
              i += 2;
            }
          } else {
            i++;
            token += input[i];
            i++;
          }
        } else {
          token += input[i];
          i++;
        }
      }
      if (i < len) i++; // skip closing quote
      tokens.push({ text: token, wasQuoted: true });
    } else {
      // Unquoted token — preserve embedded quotes (e.g., key:"value" → key:"value")
      let token = "";
      while (i < len && input[i] !== " ") {
        if (input[i] === '"') {
          // Embedded quoted value — preserve quotes in token for downstream detection
          token += '"';
          i++; // skip opening quote
          while (i < len && input[i] !== '"') {
            if (input[i] === "\\" && i + 1 < len) {
              const next = input[i + 1];
              if (next === "n") {
                token += "\n";
                i += 2;
              } else if (next === "u") {
                // \uXXXX — read 4 hex digits
                const hex = input.slice(i + 2, i + 6);
                if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
                  token += String.fromCharCode(parseInt(hex, 16));
                  i += 6;
                } else {
                  // Invalid hex — pass through literally
                  token += "\\u";
                  i += 2;
                }
              } else {
                i++;
                token += input[i];
                i++;
              }
            } else {
              token += input[i];
              i++;
            }
          }
          if (i < len) {
            token += '"';
            i++; // skip closing quote
          }
        } else {
          token += input[i];
          i++;
        }
      }
      // Convert literal \n and \uXXXX in unquoted tokens
      tokens.push({ text: token.replace(/\\n/g, "\n").replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), wasQuoted: false });
    }
  }

  return tokens;
}

/**
 * Tokenize an operation string by whitespace, respecting quoted strings.
 * "add svc \"Auth Service\" theme:blue" -> ["add", "svc", "Auth Service", "theme:blue"]
 */
export function tokenize(input: string): string[] {
  return tokenizeWithMeta(input).map(t => t.text);
}

/**
 * Regex patterns for cell range detection (spreadsheet A1 notation).
 * Cell ref: 1-3 letters followed by digits (A1, BB23, XFD1048576)
 * Row ref: digits only (1, 23)
 *
 * Note: Pure column ranges (A:E, B:B) are intentionally NOT detected here
 * because they are ambiguous with key:value pairs like "theme:blue" or
 * "vel:mf". Column-only ranges should use hyphen syntax (A-E) or be
 * handled at the domain level.
 */
const CELL_REF_RE = /^[A-Za-z]{1,3}\d+$/;
const ROW_REF_RE = /^[0-9]+$/;

/**
 * Check if a token looks like a spreadsheet cell range.
 *
 * Recognized patterns (with optional Sheet! prefix):
 *   A1:F1     — cell range (letters+digits : letters+digits)
 *   3:3       — row range (digits : digits)
 *   1:5       — row range
 *   Sheet2!A1:B10 — cross-sheet cell range
 *
 * NOT recognized (ambiguous with key:value):
 *   A:E       — column range (use A-E instead, or handle at domain level)
 */
export function isCellRange(token: string): boolean {
  let ref = token;
  // Strip optional sheet prefix (Sheet2!A1:B10 → A1:B10)
  const bangIdx = ref.indexOf("!");
  if (bangIdx >= 0) {
    ref = ref.slice(bangIdx + 1);
  }

  const colonIdx = ref.indexOf(":");
  if (colonIdx <= 0 || colonIdx >= ref.length - 1) return false;

  const left = ref.slice(0, colonIdx);
  const right = ref.slice(colonIdx + 1);

  // Cell range: A1:F1 (most common spreadsheet range pattern)
  if (CELL_REF_RE.test(left) && CELL_REF_RE.test(right)) return true;
  // Row range: 1:5 or 3:3 (no FCP key is ever a pure number)
  if (ROW_REF_RE.test(left) && ROW_REF_RE.test(right)) return true;

  return false;
}

/**
 * Check if a token is a key:value pair.
 * Must contain ":" but not start with "@" (selectors), not be an arrow,
 * not be a formula (starts with "="), and not be a cell range (e.g. A1:F1).
 */
export function isKeyValue(token: string): boolean {
  if (token.startsWith("@")) return false;
  if (isArrow(token)) return false;
  // Formulas (=SUM(A1:B2)) are values, not key:value pairs
  if (token.startsWith("=")) return false;
  // Spreadsheet cell ranges (A1:F1, B:B, 3:3) are positional args
  if (isCellRange(token)) return false;
  const colonIdx = token.indexOf(":");
  return colonIdx > 0 && colonIdx < token.length - 1;
}

/**
 * Parse a key:value token. The value may include colons (e.g., "style:orthogonal").
 * Strips surrounding quotes from the value for backwards compatibility.
 */
export function parseKeyValue(token: string): { key: string; value: string } {
  const colonIdx = token.indexOf(":");
  let value = token.slice(colonIdx + 1);
  // Strip surrounding quotes preserved by tokenizer
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  return {
    key: token.slice(0, colonIdx),
    value,
  };
}

/**
 * Parse a key:value token with metadata about quoting.
 * Returns the unquoted value plus a `wasQuoted` flag.
 */
export function parseKeyValueWithMeta(token: string): { key: string; value: string; wasQuoted: boolean } {
  const colonIdx = token.indexOf(":");
  let value = token.slice(colonIdx + 1);
  let wasQuoted = false;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
    wasQuoted = true;
  }
  return {
    key: token.slice(0, colonIdx),
    value,
    wasQuoted,
  };
}

/**
 * Check if a token is an arrow operator.
 */
export function isArrow(token: string): boolean {
  return token === "->" || token === "<->" || token === "--";
}

/**
 * Check if a token is a selector (@-prefixed).
 */
export function isSelector(token: string): boolean {
  return token.startsWith("@");
}
