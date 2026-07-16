"""Convenience runner for mind-base E2E tests.

Usage:
    python run.py                    # run all
    python run.py --module m1_auth   # run one module
    python run.py --scenario         # run only scenarios
    python run.py --headless         # headless mode
    python run.py --report           # generate allure report after run
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser(description="mind-base E2E runner")
    parser.add_argument("--module", choices=["m1_auth", "m2_favorites", "m3_knowledge", "m4_chat", "m5_quiz"], help="run a single module")
    parser.add_argument("--scenario", action="store_true", help="run only end-to-end scenarios")
    parser.add_argument("--smoke", action="store_true", help="run only smoke tests")
    parser.add_argument("--headless", action="store_true", help="run headless")
    parser.add_argument("--report", action="store_true", help="open allure report after run")
    parser.add_argument("--clean", action="store_true", help="clean reports dir before run")
    args, extra = parser.parse_known_args()

    if args.clean:
        reports = ROOT / "reports"
        if reports.exists():
            for child in reports.iterdir():
                if child.is_dir():
                    for f in child.iterdir():
                        try:
                            f.unlink()
                        except Exception:
                            pass

    cmd = [sys.executable, "-m", "pytest", "-c", str(ROOT / "pytest.ini")]
    if args.module:
        cmd += ["-m", args.module]
    elif args.scenario:
        cmd += ["-m", "scenario"]
    elif args.smoke:
        cmd += ["-m", "smoke"]
    if args.headless:
        cmd += ["--headless"]
    cmd += extra

    print(f"[run] {' '.join(cmd)}")
    rc = subprocess.call(cmd, cwd=str(ROOT))
    if rc == 0 and args.report:
        subprocess.call(["allure", "serve", str(ROOT / "reports" / "allure-results")])
    return rc


if __name__ == "__main__":
    sys.exit(main())
