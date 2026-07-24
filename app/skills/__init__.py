"""Skills - packaged instruction packs loaded from MinIO (never local disk).

Skills are downloaded from an external skill store into MinIO as zips; their
metadata lives in the ``installed_skills`` MySQL table. ``SkillManager``
lazily loads a skill's instructions from MinIO when the agent calls
``load_skill``. Code tools inside a skill are not executed yet (sandbox
pending).
"""

from .manager import SkillManager
from .zip_parser import Skill

__all__ = ["Skill", "SkillManager"]
