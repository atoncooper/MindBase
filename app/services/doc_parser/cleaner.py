"""Text cleaning pipeline for parsed documents."""

import re


def clean_document_text(text: str) -> str:
    """Apply unified cleaning pipeline to parsed document text."""
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    text = re.sub(r" {2,}", " ", text)
    return text.strip()
