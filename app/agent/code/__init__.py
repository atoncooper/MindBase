"""Code Agent - writes code and runs it in a Daytona sandbox via run_code.

Sub-agent called by the chat agent via delegate_to_agent (like note/memory).
Architecture mirrors the note agent: 5-node ReAct, only binds ``run_code``.
"""

from .graph import build_code_agent
from .state import CodeAgentState

__all__ = ["CodeAgentState", "build_code_agent"]
