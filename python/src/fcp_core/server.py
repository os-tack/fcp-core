"""FCP server factory — creates a fully wired MCP server for any domain.

Registers 4 tools: {domain}, {domain}_query, {domain}_session, {domain}_help.
Embeds the reference card in the main tool description.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Generic, Protocol, TypeVar

from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

from fcp_core.event_log import EventLog
from fcp_core.formatter import format_result
from fcp_core.parsed_op import ParsedOp, ParseError, parse_op
from fcp_core.session import SessionDispatcher, SessionHooks
from fcp_core.verb_registry import VerbRegistry, VerbSpec

M = TypeVar("M")  # Model type
E = TypeVar("E")  # Event type


@dataclass
class OpResult:
    """Result of dispatching a single operation."""

    success: bool
    message: str
    prefix: str = ""


class FcpDomainAdapter(Protocol[M, E]):
    """Protocol that domain implementations must satisfy."""

    def create_empty(self, title: str, params: dict[str, str]) -> M:
        """Create a new empty model."""
        ...

    def serialize(self, model: M, path: str) -> None:
        """Serialize the model to a file."""
        ...

    def deserialize(self, path: str) -> M:
        """Deserialize a model from a file."""
        ...

    def rebuild_indices(self, model: M) -> None:
        """Rebuild any indices on the model."""
        ...

    def get_digest(self, model: M) -> str:
        """Return a human-readable digest of the model."""
        ...

    def dispatch_op(self, op: ParsedOp, model: M, log: EventLog[E]) -> OpResult:
        """Execute a parsed operation on the model."""
        ...

    def dispatch_query(self, query: str, model: M) -> str:
        """Execute a query against the model."""
        ...

    def reverse_event(self, event: E, model: M) -> None:
        """Reverse a single event (for undo)."""
        ...

    def replay_event(self, event: E, model: M) -> None:
        """Replay a single event (for redo)."""
        ...

    def take_snapshot(self, model: M) -> Any | None:
        """Return opaque snapshot for batch rollback. Return None to skip atomicity."""
        return None

    def restore_snapshot(self, model: M, snapshot: Any) -> None:
        """Restore model from snapshot and rebuild indices."""
        pass


class _AdapterSessionHooks(Generic[M, E]):
    """Bridges FcpDomainAdapter to SessionHooks protocol."""

    def __init__(self, adapter: FcpDomainAdapter[M, E]) -> None:
        self._adapter = adapter

    def on_new(self, params: dict[str, str]) -> M:
        title = params.pop("title", "Untitled")
        return self._adapter.create_empty(title, params)

    def on_open(self, path: str) -> M:
        return self._adapter.deserialize(path)

    def on_save(self, model: M, path: str) -> None:
        self._adapter.serialize(model, path)

    def on_rebuild_indices(self, model: M) -> None:
        self._adapter.rebuild_indices(model)

    def get_digest(self, model: M) -> str:
        return self._adapter.get_digest(model)


def _build_tool_description(
    domain: str,
    registry: VerbRegistry,
    extra_sections: dict[str, str] | None = None,
) -> str:
    """Build the inline tool description embedding the reference card."""
    lines: list[str] = []
    lines.append(
        f"Execute {domain} operations. Each op string follows: "
        f"VERB TARGET [key:value ...]\n"
        f"Call {domain}_help for the full reference card.\n"
    )

    # Group verbs by category
    seen_categories: list[str] = []
    for v in registry.verbs:
        if v.category not in seen_categories:
            seen_categories.append(v.category)

    for cat in seen_categories:
        cat_verbs = [v for v in registry.verbs if v.category == cat]
        if not cat_verbs:
            continue
        cat_title = cat.replace("_", " ").replace("-", " ").upper()
        lines.append(f"{cat_title}:")
        for v in cat_verbs:
            lines.append(f"  {v.syntax}")
        lines.append("")

    if extra_sections:
        for title, content in extra_sections.items():
            lines.append(f"{title.upper()}:")
            lines.append(content)
            lines.append("")

    return "\n".join(lines)


def create_fcp_server(
    domain: str,
    adapter: FcpDomainAdapter,
    verbs: list[VerbSpec],
    *,
    extra_sections: dict[str, str] | None = None,
    is_positional: Callable[[str], bool] | None = None,
    **kwargs,
) -> FastMCP:
    """Create a fully wired MCP server for the given domain.

    Registers 4 tools:
    - ``{domain}`` — execute operations (batch)
    - ``{domain}_query`` — query model state
    - ``{domain}_session`` — session lifecycle
    - ``{domain}_help`` — reference card

    Parameters
    ----------
    domain : str
        Domain name (e.g. "midi", "drawio"). Used as tool name prefix.
    adapter : FcpDomainAdapter
        Domain-specific adapter implementing the protocol.
    verbs : list[VerbSpec]
        Verb specifications for this domain.
    extra_sections : dict[str, str] | None
        Additional sections for the reference card.
    is_positional : callable, optional
        Domain-level callback for ``parse_op``: ``is_positional(token) -> bool``.
        If provided, tokens matching this predicate are classified as positionals
        instead of key:value params (e.g. column ranges like ``B:G``).
    **kwargs
        Additional arguments passed to FastMCP constructor.

    Returns
    -------
    FastMCP
        Configured MCP server ready to run.
    """
    registry = VerbRegistry()
    registry.register_many(verbs)

    event_log: EventLog = EventLog()

    hooks = _AdapterSessionHooks(adapter)
    session = SessionDispatcher(
        hooks=hooks,
        event_log=event_log,
        reverse_event=adapter.reverse_event,
        replay_event=adapter.replay_event,
    )

    mcp = FastMCP(**kwargs)
    log = logging.getLogger(f"fcp-{domain}")

    # Build tool description with embedded reference card
    tool_description = _build_tool_description(domain, registry, extra_sections)
    reference_card = registry.generate_reference_card(extra_sections)

    @mcp.tool(name=domain, description=tool_description, structured_output=False)
    def execute_ops(ops: list[str]) -> TextContent:
        if session.model is None:
            return TextContent(type="text", text=format_result(False, "No model loaded. Use session 'new' or 'open' first."))

        # Pre-process: split ops containing embedded newlines into separate ops.
        # LLMs sometimes send data blocks as a single string with \n instead of
        # separate array elements — expand them so data block mode works correctly.
        expanded: list[str] = []
        for raw in ops:
            if '\n' in raw:
                expanded.extend(line for line in raw.split('\n') if line.strip())
            else:
                expanded.append(raw)
        ops = expanded

        # Snapshot for batch atomicity (C7) — adapter opts in via take_snapshot
        take_snap = getattr(adapter, 'take_snapshot', None)
        snapshot = take_snap(session.model) if take_snap else None

        results: list[str] = []
        for i, op_str in enumerate(ops):
            parsed = parse_op(op_str, is_positional=is_positional)
            if isinstance(parsed, ParseError):
                log.warning("Parse error: %s (op: %s)", parsed.error, op_str)
                if snapshot is not None:
                    adapter.restore_snapshot(session.model, snapshot)
                    msg = (
                        f"! Batch failed at op {i + 1}: {op_str}. "
                        f"Error: {parsed.error}. "
                        f"State rolled back ({i} ops reverted)."
                    )
                    return TextContent(type="text", text=msg)
                results.append(format_result(False, parsed.error))
                continue

            result = adapter.dispatch_op(parsed, session.model, session.event_log)

            if not result.success and result.message and snapshot is not None:
                log.warning("Batch rollback at op %d: %s — %s", i + 1, op_str, result.message)
                adapter.restore_snapshot(session.model, snapshot)
                msg = (
                    f"! Batch failed at op {i + 1}: {op_str}. "
                    f"Error: {result.message}. "
                    f"State rolled back ({i} ops reverted)."
                )
                return TextContent(type="text", text=msg)

            formatted = format_result(result.success, result.message, result.prefix)
            if formatted.strip():
                results.append(formatted)

        body = "\n".join(results)
        digest = adapter.get_digest(session.model)
        return TextContent(type="text", text=f"{body}\n{digest}" if digest else body)

    @mcp.tool(name=f"{domain}_query", structured_output=False)
    def execute_query(q: str) -> TextContent:
        f"""Query {domain} state."""
        if session.model is None:
            return TextContent(type="text", text=format_result(False, "No model loaded."))
        return TextContent(type="text", text=adapter.dispatch_query(q, session.model))

    @mcp.tool(name=f"{domain}_session", structured_output=False)
    def execute_session(action: str) -> TextContent:
        f"""Session: 'new "Title"', 'open ./file', 'save', 'checkpoint v1', 'undo', 'redo'"""
        log.info("Session: %s", action)
        text = session.dispatch(action)
        if session.model is not None:
            digest = adapter.get_digest(session.model)
            text = f"{text}\n{digest}" if digest else text
        return TextContent(type="text", text=text)

    @mcp.tool(name=f"{domain}_help", structured_output=False)
    def get_help() -> str:
        f"""Returns the {domain} reference card with all syntax."""
        return reference_card

    # ── Resources ────────────────────────────────────────
    @mcp.resource(
        uri=f"fcp://{domain}/session",
        name="session-status",
        description=f"Current {domain} session state",
        mime_type="text/plain",
    )
    def read_session() -> str:
        return _build_session_resource(session, adapter, domain)

    get_model_summary = getattr(adapter, "get_model_summary", None)
    if get_model_summary:
        @mcp.resource(
            uri=f"fcp://{domain}/model",
            name="model-overview",
            description=f"Current {domain} model contents",
            mime_type="text/plain",
        )
        def read_model() -> str:
            return get_model_summary(session.model) if session.model else "No model loaded."

    return mcp


def _build_session_resource(
    session: SessionDispatcher,
    adapter: FcpDomainAdapter,
    domain: str,
) -> str:
    """Build the session status resource text."""
    if session.model is None:
        return f"No {domain} session active."
    lines: list[str] = []
    if session.file_path:
        lines.append(f"File: {session.file_path}")
    lines.append(f"State: {adapter.get_digest(session.model)}")
    return "\n".join(lines)
