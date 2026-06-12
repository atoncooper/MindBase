"""Chat Agent — ReAct pattern orchestrator for Q&A.

The Chat Agent uses the ReAct (Reasoning + Acting) pattern:
    LLM observes → decides which tool to call → executes → observes → repeat or answer

Tools available to the LLM:
    - vector_search: semantic search over the knowledge base
    - list_videos: list videos from favorite folders (DB query)
    - get_video_summaries: get detailed video descriptions (DB query)

The LLM is in the loop — it decides which tools to call, whether
results are sufficient, and when to produce the final answer.
"""

from .graph import build_chat_agent, create_chat_agent
from .state import ChatAgentResult, ChatAgentState

__all__ = [
    "ChatAgentState",
    "ChatAgentResult",
    "build_chat_agent",
    "create_chat_agent",
]
