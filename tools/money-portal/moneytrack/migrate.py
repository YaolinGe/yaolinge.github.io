"""Import an existing ad-hoc money CSV into the ledger schema.

    python3 -m moneytrack.migrate old.csv                 # dry run, prints a report
    python3 -m moneytrack.migrate old.csv --out ledger.csv

Column names are matched loosely (English and Norwegian), so the messy file
that started all this usually needs no manual mapping.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from .errors import ValidationError
from .ledger import Entry, Ledger, new_id, parse_amount, parse_date, sanitise_text

ALIASES = {
    "date": ["date", "dato", "day", "when", "dag", "timestamp", "time"],
    "amount": [
        "amount", "beløp", "belop", "sum", "kr", "cost", "price", "pris",
        "value", "spent", "total", "utgift", "kostnad",
    ],
    "category": ["category", "kategori", "type", "kind", "group", "gruppe"],
    "description": [
        "description", "desc", "note", "notes", "comment", "kommentar", "text",
        "tekst", "what", "hva", "item", "beskrivelse", "notat",
    ],
    "method": ["method", "payment", "paid", "betaling", "card", "account", "konto"],
    "currency": ["currency", "valuta", "cur"],
    "tags": ["tags", "tag", "labels", "merkelapp"],
}


def match_columns(header: list[str]) -> dict[str, str]:
    """Map ledger fields to the columns of the incoming file."""
    mapping: dict[str, str] = {}
    normalised = {name: (name or "").strip().lower() for name in header}
    for field_name, aliases in ALIASES.items():
        for column, lowered in normalised.items():
            if lowered in aliases:
                mapping[field_name] = column
                break
        if field_name in mapping:
            continue
        for column, lowered in normalised.items():
            if any(alias in lowered for alias in aliases):
                mapping[field_name] = column
                break
    return mapping


def convert(rows: list[dict], mapping: dict[str, str], *, currency: str = "NOK") -> tuple[list[Entry], list[dict]]:
    entries: list[Entry] = []
    problems: list[dict] = []
    for line_no, row in enumerate(rows, start=2):
        if not any((value or "").strip() for value in row.values()):
            continue
        try:
            if "amount" not in mapping:
                raise ValidationError("amount", "no amount-like column found")
            entry = Entry(
                id=new_id(),
                amount=parse_amount(row.get(mapping["amount"])),
                date=parse_date(row.get(mapping.get("date", ""), "")),
                category=sanitise_text(row.get(mapping.get("category", ""), ""), "category", 60).lower()
                or "uncategorised",
                description=sanitise_text(row.get(mapping.get("description", ""), ""), "description"),
                currency=(sanitise_text(row.get(mapping.get("currency", ""), ""), "currency", 8) or currency).upper(),
                method=sanitise_text(row.get(mapping.get("method", ""), ""), "method", 30).lower(),
                tags=sanitise_text(row.get(mapping.get("tags", ""), ""), "tags", 100).lower(),
                source="import",
            )
        except ValidationError as exc:
            problems.append({"line": line_no, "field": exc.field, "error": exc.message, "row": row})
            continue
        entries.append(entry)
    return entries, problems


def read_rows(path: Path) -> tuple[list[str], list[dict]]:
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        sample = handle.read(4096)
        handle.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(handle, dialect=dialect)
        return list(reader.fieldnames or []), list(reader)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import an old money CSV into the ledger")
    parser.add_argument("source", help="the CSV file you have been keeping by hand")
    parser.add_argument("--out", help="ledger to append to (omit for a dry run)")
    parser.add_argument("--currency", default="NOK")
    args = parser.parse_args(argv)

    source = Path(args.source).expanduser()
    header, rows = read_rows(source)
    mapping = match_columns(header)
    entries, problems = convert(rows, mapping, currency=args.currency)

    print(f"source     {source} ({len(rows)} data rows)")
    print(f"columns    {', '.join(header)}")
    for field_name in ALIASES:
        print(f"  {field_name:<12} -> {mapping.get(field_name, '(none)')}")
    print(f"convertible {len(entries)}")
    print(f"problems    {len(problems)}")
    for problem in problems[:20]:
        print(f"  line {problem['line']}: {problem['field']}: {problem['error']}")

    if not args.out:
        print("\ndry run - pass --out <ledger.csv> to write these entries")
        return 0

    ledger = Ledger(args.out)
    ledger.ensure()
    for entry in entries:
        ledger.append(entry)
    print(f"\nwrote {len(entries)} entries to {ledger.path}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
