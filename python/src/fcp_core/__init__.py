"""FCP Core — File Context Protocol framework for building MCP servers."""

from fcp_core.event_log import CheckpointEvent, EventLog
from fcp_core.formatter import format_result, suggest
from fcp_core.parsed_op import ParseError, ParsedOp, parse_op
from fcp_core.bridge import connect_to_slipstream
from fcp_core.server import FcpDomainAdapter, OpResult, create_fcp_server
from fcp_core.session import SessionDispatcher, SessionHooks
from fcp_core.tokenizer import (
    TokenMeta,
    is_arrow,
    is_key_value,
    is_selector,
    parse_key_value,
    tokenize,
    tokenize_with_meta,
)
from fcp_core.verb_registry import VerbRegistry, VerbSpec

__all__ = [
    # Tokenizer
    "tokenize",
    "tokenize_with_meta",
    "TokenMeta",
    "is_key_value",
    "parse_key_value",
    "is_selector",
    "is_arrow",
    # Parsed Op
    "ParsedOp",
    "ParseError",
    "parse_op",
    # Event Log
    "EventLog",
    "CheckpointEvent",
    # Verb Registry
    "VerbSpec",
    "VerbRegistry",
    # Session
    "SessionHooks",
    "SessionDispatcher",
    # Formatter
    "format_result",
    "suggest",
    # Server
    "FcpDomainAdapter",
    "OpResult",
    "create_fcp_server",
    "connect_to_slipstream",
]
