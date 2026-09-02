"""Tests for the command line entry point and configuration precedence."""

import contextlib
import io
from pathlib import Path

from support import TempLedgerCase  # noqa: E402  (sets sys.path)

import server  # noqa: E402
from moneytrack.config import Config  # noqa: E402


class ConfigTests(TempLedgerCase):
    def test_environment_is_read(self):
        config = Config.from_env(
            {
                "MONEY_LEDGER": str(self.ledger_path),
                "MONEY_PORT": "9000",
                "MONEY_CURRENCY": "eur",
                "MONEY_CATEGORIES": "Food, Travel",
                "MONEY_GIT_SYNC": "yes",
            }
        )
        self.assertEqual(config.ledger_path, self.ledger_path)
        self.assertEqual(config.port, 9000)
        self.assertEqual(config.currency, "EUR")
        self.assertEqual(config.categories, ["food", "travel"])
        self.assertTrue(config.git_sync)
        self.assertFalse(config.git_push)

    def test_defaults_are_private(self):
        config = Config.from_env({})
        self.assertEqual(config.host, "127.0.0.1")
        self.assertFalse(config.is_public)
        self.assertFalse(config.git_sync)
        self.assertEqual(config.ledger_path, Path.home() / ".money-portal" / "ledger.csv")

    def test_binding_the_lan_counts_as_public(self):
        self.assertTrue(Config(host="0.0.0.0").is_public)
        self.assertTrue(Config(host="192.168.1.20").is_public)
        self.assertFalse(Config(host="localhost").is_public)


class CommandLineTests(TempLedgerCase):
    def test_flags_win_over_environment(self):
        config = server.config_from(
            server.parse_args(["--ledger", str(self.ledger_path), "--port", "9999", "--token", "abc"])
        )
        self.assertEqual(config.port, 9999)
        self.assertEqual(config.token, "abc")

    def test_push_implies_sync(self):
        config = server.config_from(server.parse_args(["--git-push"]))
        self.assertTrue(config.git_sync)

    def test_refuses_an_open_bind_without_a_token(self):
        buffer = io.StringIO()
        with contextlib.redirect_stderr(buffer):
            code = server.main(["--host", "0.0.0.0", "--ledger", str(self.ledger_path)])
        self.assertEqual(code, 2)
        self.assertIn("Refusing to listen", buffer.getvalue())
        self.assertFalse(self.ledger_path.exists())

    def test_lan_address_is_a_string(self):
        self.assertIsInstance(server.lan_address(), str)
