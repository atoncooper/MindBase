"""Summary Agent - detailed summaries of a chat session.

Registered with the AgentHarness lifecycle manager (like the quiz agent)
but NOT with the orchestrator — it is triggered by the frontend
"summarize session" button via ``POST /chat/sessions/{id}/summary``,
not by chat routing.

Architecture::

    START -> inject_prompt -> agent -> format_result -> END
                 │               │
                 │               └──(error)──┐
                 └──(error / empty)──────────┤
                                            ▼
                                       error_node ──(retry)──> failed node

The inject node fetches the full history from MongoDB itself; no tools
are bound, so the summary is a single LLM call.
"""

from .graph import build_summary_agent
from .state import SummaryAgentState

__all__ = ["SummaryAgentState", "build_summary_agent"]
