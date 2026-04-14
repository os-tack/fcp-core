# fcp-core

Shared framework for building [FCP](https://github.com/os-tack/fcp) servers -- dual TypeScript and Python implementations.

## What It Does

FCP (File Context Protocol) is an application framework for building MCP servers that let LLMs interact with complex file formats through a verb-based DSL. fcp-core provides the foundational plumbing that every FCP server shares: tokenization, operation parsing, verb dispatch, event sourcing (undo/redo), session lifecycle, response formatting, and a server factory that wires it all together. FCP is to MCP what React is to the DOM -- the LLM thinks in domain operations, FCP renders them into the target format.

## Quick Example

Every FCP server exposes exactly 4 MCP tools:

| Tool | Purpose | Parameter |
|------|---------|-----------|
| `{domain}(ops)` | Batch mutations | `ops: string[]` |
| `{domain}_query(q)` | Read-only inspection | `q: string` |
| `{domain}_session(action)` | Session lifecycle | `action: string` |
| `{domain}_help()` | Reference card | -- |

All operations follow a common grammar:

```
VERB [positionals...] [key:value params...] [@selectors...]
```

Creating an FCP server with `createFcpServer`:

```typescript
import { createFcpServer } from '@ostk-ai/fcp-core';

const server = createFcpServer({
  domain: 'midi',
  verbs: { note: handleNote, chord: handleChord, tempo: handleTempo },
  queries: { map: handleMap, describe: handleDescribe },
});
```

Python equivalent with `create_fcp_server`:

```python
from fcp_core import create_fcp_server

server = create_fcp_server(
    domain="midi",
    verbs={"note": handle_note, "chord": handle_chord, "tempo": handle_tempo},
    queries={"map": handle_map, "describe": handle_describe},
)
```

## Installation

**TypeScript** (Node >= 22):

```bash
npm install @ostk-ai/fcp-core
```

**Python** (>= 3.11):

```bash
pip install fcp-core
```

## Architecture

fcp-core provides these modules in both TypeScript and Python:

| Module | Purpose |
|--------|---------|
| **Tokenizer** | Quote-aware splitting of operation strings |
| **Parsed Op** | Structural classification into verb, positionals, params, selectors |
| **Verb Registry** | Registration and dispatch of domain verb handlers |
| **Event Log** | Append-only event sourcing with undo/redo and checkpoints |
| **Session** | Lifecycle management (new, open, save, checkpoint, undo, redo) |
| **Formatter** | Response prefix conventions (`+` created, `~` connected, `*` modified, `-` deleted) |
| **Server** | Factory that wires everything into an MCP server |

The full specification lives in [`spec/`](spec/):

- [grammar.md](spec/grammar.md) -- Tokenization and token classification
- [tools.md](spec/tools.md) -- The 4-tool architecture contract
- [session.md](spec/session.md) -- Session lifecycle actions
- [events.md](spec/events.md) -- Event log and undo/redo
- [conformance.md](spec/conformance.md) -- Conformance requirements for FCP servers

## Development

```bash
# TypeScript
cd typescript
npm install
npm test          # vitest, 107 tests
npm run build     # tsc

# Python
cd python
uv sync
uv run pytest     # 112 tests
```

## License

MIT

