"""Pydantic schemas for user preferences."""

from typing import Any, Dict

from pydantic import BaseModel


class PreferencesResponse(BaseModel):
    """All preferences for the current user."""

    preferences: Dict[str, Any]


class PreferenceUpdateRequest(BaseModel):
    """Partial update of preferences. Top-level keys are preference keys."""

    preferences: Dict[str, Any]
