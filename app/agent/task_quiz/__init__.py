"""task-quiz agent: standalone LangGraph agent for defining scheduled quiz tasks.

Independent of the main chat agent (separate /task-quiz/chat interface).
Uses langgraph create_react_agent + 3 tools (random_time / submit_task / query_task).
"""
