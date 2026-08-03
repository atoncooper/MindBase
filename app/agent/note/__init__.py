"""Note Agent - composes Markdown notes and saves them via the save_note tool.

This agent is a sub-agent called by the chat agent via delegate_to_agent
(like the memory agent). It does NOT chat with users directly.

Architecture::

    START -> inject_prompt -> agent ──(tool_calls)──-> runtime_dispatch -> agent (loop)
                              │
                              └──(respond)──-> format_result -> END

    error_node ◄──(error on any node)

Only the ``save_note`` tool is bound (via ``list_tool_defs(names=["save_note"])``).
"""

from .graph import build_note_agent
from .state import NoteAgentState

__all__ = ["NoteAgentState", "build_note_agent"]
