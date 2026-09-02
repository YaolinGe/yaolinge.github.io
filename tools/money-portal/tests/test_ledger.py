"""Tests for parsing, validation and the CSV file itself."""

import csv
import datetime as dt
from decimal import Decimal

from support import TempLedgerCase  # noqa: E402  (sets sys.path)

from moneytrack.errors import ValidationError  # noqa: E402
from moneytrack.ledger import (  # noqa: E402
    FIELDS,
    Entry,
    Ledger,
    csv_safe,
    csv_unsafe,
    filter_entries,
    parse_amount,
    parse_date,
    parse_tags,
    sanitise_text,
    summarise,
)


class ParseAmountTests(TempLedgerCase):
    def test_accepts_the_shapes_humans_type(self):
        cases = {
            "12.50": "12.50",
            "12,50": "12.50",
            "1 234,50": "1234.50",
            "1,234.50": "1234.50",
            "1.234,50": "1234.50",
            "kr 99": "99.00",
            "99,-": "99.00",
            "NOK 1500": "1500.00",
            7: "7.00",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(parse_amount(raw), Decimal(expected))

    def test_rejects_junk_and_impossible_values(self):
        for raw in ["", None, "abc", "0", "-5", "1e400", "999999999999"]:
            with self.subTest(raw=raw), self.assertRaises(ValidationError):
                parse_amount(raw)

    def test_thousands_group_is_not_read_as_decimals(self):
        self.assertEqual(parse_amount("1,500"), Decimal("1500.00"))

    def test_amounts_keep_two_decimals_exactly(self):
        self.assertEqual(parse_amount("0.005"), Decimal("0.01"))
        self.assertEqual(str(parse_amount("10")), "10.00")


class ParseDateTests(TempLedgerCase):
    def test_defaults_and_keywords(self):
        today = dt.date.today()
        self.assertEqual(parse_date(""), today.isoformat())
        self.assertEqual(parse_date(None), today.isoformat())
        self.assertEqual(parse_date("today"), today.isoformat())
        self.assertEqual(parse_date("yesterday"), (today - dt.timedelta(days=1)).isoformat())

    def test_separators_are_normalised(self):
        self.assertEqual(parse_date("2026/03/04"), "2026-03-04")
        self.assertEqual(parse_date("2026.03.04"), "2026-03-04")

    def test_rejects_nonsense_and_the_far_future(self):
        for raw in ["04-03-2026", "not a date", "2026-13-01"]:
            with self.subTest(raw=raw), self.assertRaises(ValidationError):
                parse_date(raw)
        future = (dt.date.today() + dt.timedelta(days=30)).isoformat()
        with self.assertRaises(ValidationError):
            parse_date(future)


class SanitisingTests(TempLedgerCase):
    def test_newlines_cannot_break_a_row(self):
        self.assertEqual(sanitise_text("lunch\nwith\r\nfriends", "description"), "lunch with friends")

    def test_long_text_is_rejected(self):
        with self.assertRaises(ValidationError):
            sanitise_text("x" * 500, "description")

    def test_formula_injection_is_defused(self):
        self.assertEqual(csv_safe("=1+1"), "'=1+1")
        self.assertEqual(csv_safe("@SUM(A1)"), "'@SUM(A1)")
        self.assertEqual(csv_safe("lunch"), "lunch")

    def test_the_defused_text_reads_back_as_typed(self):
        for raw in ["=1+1", "@SUM(A1)", "-5 kroner off", "lunch", "it's fine"]:
            with self.subTest(raw=raw):
                self.assertEqual(csv_unsafe(csv_safe(raw)), raw)

    def test_tags_are_deduplicated_and_slugged(self):
        self.assertEqual(parse_tags("Ski trip, ski trip; Gear"), "ski-trip;gear")


class EntryTests(TempLedgerCase):
    def test_payload_defaults(self):
        entry = Entry.from_payload({"amount": "50"})
        self.assertEqual(entry.category, "uncategorised")
        self.assertEqual(entry.currency, "NOK")
        self.assertEqual(entry.source, "portal")
        self.assertEqual(entry.date, dt.date.today().isoformat())
        self.assertTrue(entry.id)

    def test_payload_rejects_bad_metadata(self):
        for payload in [
            {"amount": "5", "currency": "kroner"},
            {"amount": "5", "source": "whatever"},
            {"amount": "5", "id": "bad id!"},
        ]:
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                Entry.from_payload(payload)

    def test_row_round_trip(self):
        entry = Entry.from_payload(
            {"amount": "123.45", "category": "Groceries", "description": "Rema", "tags": "food"}
        )
        restored = Entry.from_row(dict(zip(FIELDS, entry.to_row())))
        self.assertEqual(restored.amount, entry.amount)
        self.assertEqual(restored.category, "groceries")
        self.assertEqual(restored.description, "Rema")


class LedgerFileTests(TempLedgerCase):
    def ledger(self):
        ledger = Ledger(self.ledger_path)
        ledger.ensure()
        return ledger

    def test_ensure_writes_only_a_header(self):
        ledger = self.ledger()
        with self.ledger_path.open() as handle:
            rows = list(csv.reader(handle))
        self.assertEqual(rows, [FIELDS])
        self.assertEqual(ledger.read_all(), [])

    def test_append_and_read_back(self):
        ledger = self.ledger()
        ledger.append(Entry.from_payload({"amount": "10", "category": "coffee", "date": "2026-01-05"}))
        ledger.append(Entry.from_payload({"amount": "20", "category": "lunch", "date": "2026-01-04"}))
        entries = ledger.read_all()
        self.assertEqual([item.date for item in entries], ["2026-01-04", "2026-01-05"])
        self.assertEqual(sum(item.amount for item in entries), Decimal("30.00"))

    def test_appending_the_same_id_twice_is_not_a_duplicate(self):
        ledger = self.ledger()
        payload = {"id": "abc123", "amount": "10", "category": "coffee"}
        ledger.append(Entry.from_payload(payload))
        ledger.append(Entry.from_payload(payload))
        self.assertEqual(len(ledger.read_all()), 1)

    def test_delete_rewrites_the_file(self):
        ledger = self.ledger()
        keep = Entry.from_payload({"amount": "10", "category": "coffee"})
        drop = Entry.from_payload({"amount": "20", "category": "lunch"})
        ledger.append(keep)
        ledger.append(drop)
        removed = ledger.delete(drop.id)
        self.assertIsNotNone(removed)
        self.assertEqual([item.id for item in ledger.read_all()], [keep.id])
        self.assertIsNone(ledger.delete("does-not-exist"))
        with self.ledger_path.open() as handle:
            self.assertEqual(next(csv.reader(handle)), FIELDS)

    def test_a_formula_description_survives_a_round_trip(self):
        ledger = self.ledger()
        ledger.append(Entry.from_payload({"amount": "10", "description": "=1+1", "category": "-odd"}))
        stored = ledger.read_all()[0]
        self.assertEqual(stored.description, "=1+1")
        self.assertEqual(stored.category, "-odd")
        self.assertIn("'=1+1", self.ledger_path.read_text())

    def test_a_description_with_a_comma_survives(self):
        ledger = self.ledger()
        ledger.append(Entry.from_payload({"amount": "10", "description": 'coffee, cake and "more"'}))
        self.assertEqual(ledger.read_all()[0].description, 'coffee, cake and "more"')

    def test_unreadable_rows_are_reported_not_swallowed(self):
        ledger = self.ledger()
        ledger.append(Entry.from_payload({"amount": "10", "category": "coffee"}))
        with self.ledger_path.open("a") as handle:
            handle.write("badid,2026-01-01T00:00:00+00:00,2026-01-01,NOT_A_NUMBER,NOK,x,,,,portal\n")
        entries, problems = ledger.read_with_problems()
        self.assertEqual(len(entries), 1)
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0]["field"], "amount")
        self.assertEqual(problems[0]["line"], 3)

    def test_blank_lines_are_ignored(self):
        ledger = self.ledger()
        ledger.append(Entry.from_payload({"amount": "10"}))
        with self.ledger_path.open("a") as handle:
            handle.write("\n\n")
        entries, problems = ledger.read_with_problems()
        self.assertEqual((len(entries), len(problems)), (1, 0))

    def test_missing_file_reads_as_empty(self):
        self.assertEqual(Ledger(self.tmp_path / "nope.csv").read_all(), [])


class ReportingTests(TempLedgerCase):
    def entries(self):
        return [
            Entry.from_payload({"amount": "100", "date": "2026-01-10", "category": "groceries"}),
            Entry.from_payload({"amount": "50.50", "date": "2026-01-20", "category": "transport"}),
            Entry.from_payload({"amount": "20", "date": "2026-02-01", "category": "groceries"}),
        ]

    def test_filter_by_month_and_category(self):
        entries = self.entries()
        self.assertEqual(len(filter_entries(entries, month="2026-01")), 2)
        self.assertEqual(len(filter_entries(entries, category="groceries")), 2)
        self.assertEqual(len(filter_entries(entries, month="2026-01", category="transport")), 1)

    def test_filter_rejects_a_malformed_month(self):
        with self.assertRaises(ValidationError):
            filter_entries(self.entries(), month="jan-2026")

    def test_summary_totals_are_exact(self):
        summary = summarise(self.entries(), today=dt.date(2026, 1, 20))
        self.assertEqual(summary["total"], "170.50")
        self.assertEqual(summary["month_total"], "150.50")
        self.assertEqual(summary["today"], "50.50")
        self.assertEqual(summary["month"], "2026-01")
        self.assertEqual(summary["month_daily_average"], "7.53")
        self.assertEqual(summary["by_category"][0], {"category": "groceries", "total": "100.00"})
        self.assertEqual([row["month"] for row in summary["by_month"]], ["2026-01", "2026-02"])

    def test_summary_of_nothing(self):
        summary = summarise([], today=dt.date(2026, 1, 20))
        self.assertEqual(summary["total"], "0.00")
        self.assertEqual(summary["count"], 0)
