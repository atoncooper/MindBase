"""task-quiz agent graph: langgraph create_react_agent.

Standalone agent (NOT registered with the main AgentHarness). Built lazily so
import-time cost is zero when the task-quiz endpoint is not used.
"""

from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

from app.agent.task_quiz.prompts import SYSTEM_PROMPT
from app.agent.task_quiz.tools import (
    query_task,
    random_time_generator,
    submit_task,
)
from app.config import settings

_TOOLS = [random_time_generator, submit_task, query_task]
_agent = None


def get_agent():
    """Lazily build the react agent (cached)."""
    global _agent
    if _agent is None:
        llm = ChatOpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url or None,
            model=settings.llm_model,
            temperature=0.3,
            streaming=True,
        )
        _agent = create_react_agent(llm, _TOOLS, prompt=SYSTEM_PROMPT)
    return _agent
