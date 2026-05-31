"""Infrastructure layer.

Cross-cutting infra adapters (DB engines, message queues, blob stores, …).
Business code under app/services/ depends on this layer; the reverse is
forbidden — see CLAUDE.md §2.2 for the call-direction contract.
"""
