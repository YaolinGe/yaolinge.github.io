"""Runtime configuration, from environment variables and CLI flags."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_LEDGER = Path.home() / ".money-portal" / "ledger.csv"
DEFAULT_CATEGORIES = [
    "groceries",
    "eating-out",
    "transport",
    "housing",
    "utilities",
    "health",
    "sport",
    "travel",
    "gear",
    "gifts",
    "subscriptions",
    "other",
]
DEFAULT_METHODS = ["card", "vipps", "cash", "transfer", "invoice"]
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _env_flag(env: dict, name: str, default: bool = False) -> bool:
    raw = env.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(env: dict, name: str, default: list[str]) -> list[str]:
    raw = env.get(name)
    if not raw or not raw.strip():
        return list(default)
    return [item.strip().lower() for item in raw.split(",") if item.strip()]


@dataclass
class Config:
    ledger_path: Path = DEFAULT_LEDGER
    host: str = "127.0.0.1"
    port: int = 8787
    currency: str = "NOK"
    categories: list[str] = field(default_factory=lambda: list(DEFAULT_CATEGORIES))
    methods: list[str] = field(default_factory=lambda: list(DEFAULT_METHODS))
    token: str = ""
    git_sync: bool = False
    git_push: bool = False
    static_dir: Path = Path(__file__).resolve().parent.parent / "static"

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Config":
        env = os.environ if env is None else env
        ledger = env.get("MONEY_LEDGER")
        return cls(
            ledger_path=Path(ledger).expanduser() if ledger else DEFAULT_LEDGER,
            host=env.get("MONEY_HOST", "127.0.0.1"),
            port=int(env.get("MONEY_PORT", "8787")),
            currency=env.get("MONEY_CURRENCY", "NOK").upper(),
            categories=_env_list(env, "MONEY_CATEGORIES", DEFAULT_CATEGORIES),
            methods=_env_list(env, "MONEY_METHODS", DEFAULT_METHODS),
            token=env.get("MONEY_TOKEN", "").strip(),
            git_sync=_env_flag(env, "MONEY_GIT_SYNC"),
            git_push=_env_flag(env, "MONEY_GIT_PUSH"),
        )

    @property
    def is_public(self) -> bool:
        """True when the portal would be reachable from the rest of the LAN."""
        return self.host not in LOOPBACK and self.host != ""

    def public_url(self) -> str:
        host = "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host
        return f"http://{host}:{self.port}/"
