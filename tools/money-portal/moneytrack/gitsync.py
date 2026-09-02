"""Optional git commit/push of the ledger after every write.

Kept deliberately dumb: it shells out to git, never raises into a request, and
reports what happened so the portal can say "saved, but git push failed".
"""

from __future__ import annotations

import subprocess
from pathlib import Path

TIMEOUT = 30


class GitSync:
    def __init__(self, ledger_path: Path, *, enabled: bool = False, push: bool = False) -> None:
        self.ledger_path = Path(ledger_path)
        self.enabled = enabled
        self.push = push
        self._repo_root: Path | None = None

    def _run(self, args: list[str], cwd: Path) -> tuple[int, str]:
        try:
            done = subprocess.run(
                ["git", *args],
                cwd=str(cwd),
                capture_output=True,
                text=True,
                timeout=TIMEOUT,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return 1, str(exc)
        return done.returncode, (done.stdout + done.stderr).strip()

    def repo_root(self) -> Path | None:
        """The work tree holding the ledger, or None when it is not in one."""
        if self._repo_root is not None:
            return self._repo_root
        parent = self.ledger_path.expanduser().parent
        if not parent.exists():
            return None
        code, out = self._run(["rev-parse", "--show-toplevel"], parent)
        if code != 0 or not out:
            return None
        self._repo_root = Path(out.splitlines()[-1].strip())
        return self._repo_root

    def commit(self, message: str) -> dict:
        """Commit (and optionally push) the ledger. Never raises."""
        if not self.enabled:
            return {"enabled": False, "status": "off"}
        root = self.repo_root()
        if root is None:
            return {"enabled": True, "status": "skipped", "detail": "ledger is not inside a git repository"}
        rel = str(self.ledger_path.expanduser().resolve())
        code, out = self._run(["add", "--", rel], root)
        if code != 0:
            return {"enabled": True, "status": "failed", "detail": out}
        code, out = self._run(["diff", "--cached", "--quiet", "--", rel], root)
        if code == 0:
            return {"enabled": True, "status": "unchanged"}
        code, out = self._run(["commit", "-m", message, "--", rel], root)
        if code != 0:
            return {"enabled": True, "status": "failed", "detail": out}
        result = {"enabled": True, "status": "committed"}
        if self.push:
            code, out = self._run(["push"], root)
            result["push"] = "ok" if code == 0 else "failed"
            if code != 0:
                result["detail"] = out
        return result
