#!/usr/bin/env python3
"""Start the money portal.

    python3 server.py                          # only this machine
    python3 server.py --host 0.0.0.0 --token secret   # the whole home network

No dependencies beyond the Python standard library.
"""

from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from moneytrack.api import build_server  # noqa: E402
from moneytrack.config import Config  # noqa: E402
from moneytrack.gitsync import GitSync  # noqa: E402
from moneytrack.ledger import Ledger  # noqa: E402


def lan_address() -> str:
    """Best guess at this machine's address on the home network."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))  # TEST-NET-1: routed nowhere, sends nothing
        return probe.getsockname()[0]
    except OSError:
        return socket.gethostname()
    finally:
        probe.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Self-hosted money portal")
    parser.add_argument("--ledger", help="path to the CSV ledger")
    parser.add_argument("--host", help="bind address (0.0.0.0 exposes it to the LAN)")
    parser.add_argument("--port", type=int, help="port to listen on")
    parser.add_argument("--token", help="shared secret required by the API")
    parser.add_argument("--git-sync", action="store_true", help="commit the ledger after each write")
    parser.add_argument("--git-push", action="store_true", help="also push after each commit")
    parser.add_argument(
        "--allow-open",
        action="store_true",
        help="bind a non-loopback address without a token (anyone on the LAN can edit)",
    )
    return parser.parse_args(argv)


def config_from(args: argparse.Namespace) -> Config:
    config = Config.from_env()
    if args.ledger:
        config.ledger_path = Path(args.ledger).expanduser()
    if args.host:
        config.host = args.host
    if args.port:
        config.port = args.port
    if args.token:
        config.token = args.token
    config.git_sync = config.git_sync or args.git_sync
    config.git_push = config.git_push or args.git_push
    if config.git_push:
        config.git_sync = True
    return config


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    config = config_from(args)

    if config.is_public and not config.token and not args.allow_open:
        print(
            "Refusing to listen on "
            f"{config.host} without a token: anyone on the network could add or delete rows.\n"
            "Set --token <secret> (recommended) or pass --allow-open if the network is trusted.",
            file=sys.stderr,
        )
        return 2

    ledger = Ledger(config.ledger_path)
    ledger.ensure()
    git = GitSync(config.ledger_path, enabled=config.git_sync, push=config.git_push)
    if config.git_sync and git.repo_root() is None:
        print(f"note: {config.ledger_path} is not inside a git repository; git sync will be skipped")

    entries, problems = ledger.read_with_problems()
    server = build_server(config, ledger, git)

    print(f"ledger   {config.ledger_path} ({len(entries)} entries)")
    if problems:
        print(f"warning  {len(problems)} row(s) could not be parsed; see the banner in the portal")
    print(f"local    {config.public_url()}")
    if config.host in {"0.0.0.0", "::"}:
        print(f"network  http://{lan_address()}:{config.port}/")
    print(f"git sync {'on' if config.git_sync else 'off'}{' + push' if config.git_push else ''}")
    print("Ctrl-C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
