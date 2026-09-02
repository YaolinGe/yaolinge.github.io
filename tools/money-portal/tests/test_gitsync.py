"""Tests for the optional git commit/push of the ledger."""

import shutil
import subprocess
import unittest

from support import TempLedgerCase  # noqa: E402  (sets sys.path)

from moneytrack.gitsync import GitSync  # noqa: E402
from moneytrack.ledger import Entry, Ledger  # noqa: E402

HAS_GIT = shutil.which("git") is not None


class GitSyncDisabledTests(TempLedgerCase):
    def test_off_by_default(self):
        result = GitSync(self.ledger_path).commit("nope")
        self.assertEqual(result, {"enabled": False, "status": "off"})

    def test_enabled_outside_a_repo_is_skipped_not_fatal(self):
        result = GitSync(self.ledger_path, enabled=True).commit("nope")
        self.assertEqual(result["status"], "skipped")


@unittest.skipUnless(HAS_GIT, "git is not installed")
class GitSyncRepoTests(TempLedgerCase):
    def setUp(self):
        super().setUp()
        self.repo = self.tmp_path / "repo"
        self.repo.mkdir()
        for args in [
            ["init", "-q", "-b", "main"],
            ["config", "user.email", "test@example.com"],
            ["config", "user.name", "Test"],
        ]:
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)
        self.ledger_path = self.repo / "ledger.csv"
        self.ledger = Ledger(self.ledger_path)
        self.ledger.ensure()
        self.git = GitSync(self.ledger_path, enabled=True)

    def log(self):
        done = subprocess.run(
            ["git", "log", "--oneline"], cwd=self.repo, capture_output=True, text=True, check=True
        )
        return done.stdout.strip().splitlines()

    def test_a_write_produces_one_commit(self):
        self.ledger.append(Entry.from_payload({"amount": "10", "category": "coffee"}))
        result = self.git.commit("money: 10 coffee")
        self.assertEqual(result["status"], "committed")
        self.assertEqual(len(self.log()), 1)
        self.assertIn("money: 10 coffee", self.log()[0])

    def test_committing_twice_without_a_change_is_a_no_op(self):
        self.ledger.append(Entry.from_payload({"amount": "10"}))
        self.git.commit("first")
        result = self.git.commit("second")
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(len(self.log()), 1)

    def test_only_the_ledger_is_committed(self):
        (self.repo / "unrelated.txt").write_text("do not commit me")
        self.ledger.append(Entry.from_payload({"amount": "10"}))
        self.git.commit("ledger only")
        done = subprocess.run(
            ["git", "show", "--name-only", "--format=", "HEAD"],
            cwd=self.repo,
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(done.stdout.split(), ["ledger.csv"])

    def test_push_failure_is_reported_not_raised(self):
        self.git.push = True
        self.ledger.append(Entry.from_payload({"amount": "10"}))
        result = self.git.commit("no remote configured")
        self.assertEqual(result["status"], "committed")
        self.assertEqual(result["push"], "failed")
