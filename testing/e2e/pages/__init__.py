"""Page Object layer for MindBase E2E tests."""
from .base_page import BasePage
from .login_page import LoginPage
from .dock_page import DockPage
from .favorites_page import FavoritesPage
from .chat_page import ChatPage
from .knowledge_page import KnowledgePage
from .quiz_page import QuizPage

__all__ = [
    "BasePage",
    "LoginPage",
    "DockPage",
    "FavoritesPage",
    "ChatPage",
    "KnowledgePage",
    "QuizPage",
]
