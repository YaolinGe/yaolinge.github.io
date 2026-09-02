"""Tests for importing an existing hand-kept CSV."""

import contextlib
import io
from decimal import Decimal

from support import TempLedgerCase  # noqa: E402  (sets sys.path)

from moneytrack.ledger import Ledger  # noqa: E402
from moneytrack.migrate import convert, main, match_columns, read_rows  # noqa: E402

MESSY = """Dato;Beløp;Kategori;Kommentar
2026-01-05;149,90;Mat;Rema 1000
2026-01-06;1 250,00;Reise;Flybillett
2026-01-07;;Mat;forgot the amount
2026-01-08;89;;kaffe
"""

ENGLISH = """Date,Cost,Type,Note
2026-01-05,12.50,food,lunch
"""


class MatchColumnsTests(TempLedgerCase):
    def test_norwegian_headers(self):
        mapping = match_columns(["Dato", "Beløp", "Kategori", "Kommentar"])
        self.assertEqual(mapping["date"], "Dato")
        self.assertEqual(mapping["amount"], "Beløp")
        self.assertEqual(mapping["category"], "Kategori")
        self.assertEqual(mapping["description"], "Kommentar")

    def test_english_headers(self):
        mapping = match_columns(["Date", "Cost", "Type", "Note"])
        self.assertEqual(mapping["amount"], "Cost")
        self.assertEqual(mapping["description"], "Note")

    def test_unknown_headers_map_to_nothing(self):
        self.assertEqual(match_columns(["a", "b"]), {})


class ConvertTests(TempLedgerCase):
    def source(self, text, name="old.csv"):
        path = self.tmp_path / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_semicolon_file_with_norwegian_numbers(self):
        header, rows = read_rows(self.source(MESSY))
        entries, problems = convert(rows, match_columns(header))
        self.assertEqual(len(entries), 3)
        self.assertEqual(entries[0].amount, Decimal("149.90"))
        self.assertEqual(entries[1].amount, Decimal("1250.00"))
        self.assertEqual(entries[0].category, "mat")
        self.assertEqual(entries[2].category, "uncategorised")
        self.assertTrue(all(entry.source == "import" for entry in entries))

    def test_rows_without_an_amount_are_reported(self):
        header, rows = read_rows(self.source(MESSY))
        _, problems = convert(rows, match_columns(header))
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0]["line"], 4)
        self.assertEqual(problems[0]["field"], "amount")

    def test_comma_file(self):
        header, rows = read_rows(self.source(ENGLISH))
        entries, problems = convert(rows, match_columns(header))
        self.assertEqual((len(entries), len(problems)), (1, 0))
        self.assertEqual(entries[0].description, "lunch")

    def test_a_file_without_any_amount_column_fails_every_row(self):
        header, rows = read_rows(self.source("a,b\n1,2\n"))
        entries, problems = convert(rows, match_columns(header))
        self.assertEqual(len(entries), 0)
        self.assertEqual(problems[0]["field"], "amount")

    def run_main(self, args):
        """main() prints a report; keep it out of the test output."""
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = main(args)
        return code, buffer.getvalue()

    def test_dry_run_writes_nothing(self):
        source = self.source(MESSY)
        code, report = self.run_main([str(source)])
        self.assertEqual(code, 0)
        self.assertIn("dry run", report)
        self.assertFalse(self.ledger_path.exists())

    def test_writing_appends_to_the_ledger(self):
        source = self.source(MESSY)
        code, _ = self.run_main([str(source), "--out", str(self.ledger_path)])
        self.assertEqual(code, 1)  # non-zero: one row could not be imported
        entries = Ledger(self.ledger_path).read_all()
        self.assertEqual(len(entries), 3)
        self.assertEqual(sum(entry.amount for entry in entries), Decimal("1488.90"))
