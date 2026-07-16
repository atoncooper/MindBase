"""
MindBase 知识库系统

路由模块初始化
"""
from app.routers import auth, favorites, favorites_v2, knowledge, chat, settings

__all__ = ["auth", "favorites", "favorites_v2", "knowledge", "chat", "settings"]
