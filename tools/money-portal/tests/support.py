"""Shared test helpers: make ``moneytrack`` importable from the tests folder."""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class TempLedgerCase(unittest.TestCase):
    """Base case giving every test its own throw-away ledger file."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.ledger_path = self.tmp_path / "ledger.csv"
        self.addCleanup(self._tmp.cleanup)
