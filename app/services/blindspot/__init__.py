"""Knowledge blind-spot map service package (Plan 1.0.6).

Aggregates four learning signals per KG entity:
- Exposure: Neo4j APPEARS_IN evidence edges
- Verification: MySQL quiz_answers / quiz_submissions + Mongo question
  entity tags
- Probing: recent user messages from Mongo chat_messages
- (P2 planned) Consolidation: notes

Read-only side path; never touches ASR/vectorization/KG build pipelines.
Degrades gracefully when any dependency is missing.
"""

from app.services.blindspot.service import BlindspotService, get_blindspot_service

__all__ = ["BlindspotService", "get_blindspot_service"]
