"""CLI entry point for the quiz AI quality harness.

Usage:
    python -m scripts.run_quiz_harness --rounds 3
    python -m scripts.run_quiz_harness --rounds 3 --output reports/quiz_harness.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.agent.quiz.harness import run_harness


async def _main(rounds: int, output: str | None) -> int:
    report = await run_harness(rounds=rounds)
    payload = {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "metrics": report.to_dict(),
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    if output:
        out_path = Path(output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        print(f"report written to {out_path}")
    else:
        print(text)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Quiz AI quality harness")
    parser.add_argument("--rounds", type=int, default=3, help="number of rounds")
    parser.add_argument("--output", type=str, default=None, help="output JSON path")
    args = parser.parse_args()
    return asyncio.run(_main(args.rounds, args.output))


if __name__ == "__main__":
    sys.exit(main())
