"""Pydantic schemas for board AI endpoints (/chat/board/*)."""

from pydantic import BaseModel, Field


class BoardCompleteRequest(BaseModel):
    """POST /chat/board/complete request.

    The anchor is identified by ``anchor_uid`` (simple-mind-map assigns a uid
    per node and it is stored in the document); ``anchor_text`` is the
    fallback matcher for documents saved before uids were present.
    """

    board_uuid: str = Field(min_length=1, description="Board the anchor node belongs to.")
    anchor_uid: str = Field(default="", description="Anchor node uid (preferred).")
    anchor_text: str = Field(default="", description="Anchor node text (fallback matcher).")
    direction: str = Field(
        default="both",
        description="Which suggestions to generate: children | siblings | both.",
    )


class NodeSuggestion(BaseModel):
    text: str = Field(min_length=1, description="Suggested node text (title when kind != text).")
    reason: str = Field(default="", description="One-line rationale shown as the chip tooltip.")
    kind: str = Field(default="text", description="text | code | md")
    code: str = Field(default="", description="Code content when kind=code.")
    language: str = Field(default="", description="Code language when kind=code.")
    markdown: str = Field(default="", description="Markdown source when kind=md.")


class BoardCompleteResponse(BaseModel):
    anchor_text: str = ""
    children: list[NodeSuggestion] = []
    siblings: list[NodeSuggestion] = []
