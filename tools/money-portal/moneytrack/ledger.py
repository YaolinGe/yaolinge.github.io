"""CSV ledger: read, validate, append and delete money entries.

Design notes
------------
* The CSV is the source of truth. Every write is a whole-row append or an
  atomic rewrite, so a crash mid-write can never leave a half row behind.
* Money is handled with ``decimal.Decimal`` only. Floats are never used for
  amounts, not even in the summaries.
* Free text is sanitised before it reaches the file: no newlines (they would
  split a row) and no leading ``= + - @`` (Excel would run those as formulas).
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import os
import re
import threading
import unicodedata
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

from .errors import ValidationError

try:  # POSIX (mac, Raspberry Pi). Absent on Windows, where we fall back.
    import fcntl
except ImportError:  # pragma: no cover - platform dependent
    fcntl = None

FIELDS = [
    "id",
    "recorded_at",
    "date",
    "amount",
    "currency",
    "category",
    "description",
    "method",
    "tags",
    "source",
]

MAX_TEXT = 200
MAX_AMOUNT = Decimal("100000000")
CENTS = Decimal("0.01")
SOURCES = ("portal", "scan", "import", "cli")

# Characters a spreadsheet would treat as the start of a formula.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_CURRENCY_JUNK = re.compile(r"(?i)\b(kr|nok|eur|usd|sek|dkk|gbp)\b|[€$£¥]")


def new_id() -> str:
    return uuid.uuid4().hex


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def sanitise_text(value, field_name: str, max_len: int = MAX_TEXT) -> str:
    """Collapse a user string into something that is safe inside one CSV cell."""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    value = unicodedata.normalize("NFC", value)
    value = _CONTROL.sub(" ", value)
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) > max_len:
        raise ValidationError(field_name, f"{field_name} is longer than {max_len} characters")
    return value


def csv_safe(value: str) -> str:
    """Neutralise spreadsheet formula injection without losing the text."""
    if value.startswith(_FORMULA_PREFIXES):
        return "'" + value
    return value


def csv_unsafe(value: str) -> str:
    """Undo :func:`csv_safe` so the portal shows what was typed."""
    if value.startswith("'") and value[1:].startswith(_FORMULA_PREFIXES):
        return value[1:]
    return value


def parse_amount(value) -> Decimal:
    """Accept what a human types: ``12,50``, ``1 234.50``, ``kr 99``, ``99.-``."""
    if isinstance(value, Decimal):
        amount = value
    elif isinstance(value, int):
        amount = Decimal(value)
    else:
        if value is None:
            raise ValidationError("amount", "amount is required")
        text = str(value)
        text = text.replace(" ", " ").replace("−", "-")
        text = _CURRENCY_JUNK.sub("", text)
        text = re.sub(r"[\s']", "", text)
        text = re.sub(r"[.,]-$", "", text)  # Norwegian "99,-" shorthand
        if not text:
            raise ValidationError("amount", "amount is required")
        if "," in text and "." in text:
            # Whichever separator comes last is the decimal one.
            if text.rindex(",") > text.rindex("."):
                text = text.replace(".", "").replace(",", ".")
            else:
                text = text.replace(",", "")
        elif text.count(",") == 1 and len(text.split(",")[1]) != 3:
            text = text.replace(",", ".")
        else:
            text = text.replace(",", "")
        try:
            amount = Decimal(text)
        except InvalidOperation:
            raise ValidationError("amount", f"{value!r} is not a number") from None
    if not amount.is_finite():
        raise ValidationError("amount", "amount must be a finite number")
    if amount >= MAX_AMOUNT:
        raise ValidationError("amount", "amount looks like a typo (too large)")
    # Round half up: 0.005 is a half øre in the customer's favour, and banker's
    # rounding (Decimal's default) surprises everyone reading a money file.
    amount = amount.quantize(CENTS, rounding=ROUND_HALF_UP)
    if amount <= 0:
        raise ValidationError("amount", "amount must be greater than zero")
    return amount


def format_amount(amount: Decimal) -> str:
    return f"{amount.quantize(CENTS, rounding=ROUND_HALF_UP):f}"


def parse_date(value, today: dt.date | None = None) -> str:
    """Return an ISO date string. Empty means today; ``today``/``yesterday`` work."""
    today = today or dt.date.today()
    if value is None or (isinstance(value, str) and not value.strip()):
        return today.isoformat()
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    text = str(value).strip().lower()
    if text == "today":
        return today.isoformat()
    if text == "yesterday":
        return (today - dt.timedelta(days=1)).isoformat()
    text = text.replace("/", "-").replace(".", "-")
    try:
        parsed = dt.date.fromisoformat(text)
    except ValueError:
        raise ValidationError("date", f"{value!r} is not a date (use YYYY-MM-DD)") from None
    if parsed > today + dt.timedelta(days=1):
        raise ValidationError("date", "date is in the future")
    if parsed.year < 1970:
        raise ValidationError("date", "date is implausibly old")
    return parsed.isoformat()


def parse_tags(value) -> str:
    if not value:
        return ""
    items = value if isinstance(value, (list, tuple)) else str(value).replace(",", ";").split(";")
    cleaned = []
    for item in items:
        tag = sanitise_text(item, "tags", 40).lower().replace(" ", "-")
        if tag and tag not in cleaned:
            cleaned.append(tag)
    if len(cleaned) > 10:
        raise ValidationError("tags", "at most 10 tags")
    return ";".join(cleaned)


@dataclass
class Entry:
    amount: Decimal
    date: str
    category: str = "uncategorised"
    description: str = ""
    currency: str = "NOK"
    method: str = ""
    tags: str = ""
    source: str = "portal"
    id: str = field(default_factory=new_id)
    recorded_at: str = field(default_factory=utc_now_iso)

    @classmethod
    def from_payload(cls, payload: dict, *, default_currency: str = "NOK") -> "Entry":
        if not isinstance(payload, dict):
            raise ValidationError("body", "expected a JSON object")
        entry_id = sanitise_text(payload.get("id") or "", "id", 64) or new_id()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", entry_id):
            raise ValidationError("id", "id may only contain letters, digits, - and _")
        currency = sanitise_text(payload.get("currency") or default_currency, "currency", 8).upper()
        if not re.fullmatch(r"[A-Z]{3}", currency):
            raise ValidationError("currency", "currency must be a 3-letter code such as NOK")
        source = sanitise_text(payload.get("source") or "portal", "source", 16).lower()
        if source not in SOURCES:
            raise ValidationError("source", f"source must be one of {', '.join(SOURCES)}")
        category = sanitise_text(payload.get("category") or "", "category", 60).lower()
        return cls(
            id=entry_id,
            amount=parse_amount(payload.get("amount")),
            date=parse_date(payload.get("date")),
            category=category or "uncategorised",
            description=sanitise_text(payload.get("description"), "description"),
            currency=currency,
            method=sanitise_text(payload.get("method") or "", "method", 30).lower(),
            tags=parse_tags(payload.get("tags")),
            source=source,
        )

    @classmethod
    def from_row(cls, row: dict) -> "Entry":
        """Read a row back. Tolerant: a partly hand-edited file still loads."""
        return cls(
            id=(row.get("id") or "").strip() or new_id(),
            recorded_at=(row.get("recorded_at") or "").strip(),
            amount=parse_amount(row.get("amount")),
            date=parse_date(row.get("date")),
            category=csv_unsafe((row.get("category") or "uncategorised").strip()).lower(),
            description=csv_unsafe((row.get("description") or "").strip()),
            currency=((row.get("currency") or "NOK").strip() or "NOK").upper(),
            method=csv_unsafe((row.get("method") or "").strip()).lower(),
            tags=csv_unsafe((row.get("tags") or "").strip()),
            source=(row.get("source") or "import").strip().lower(),
        )

    def to_row(self) -> list[str]:
        return [
            self.id,
            self.recorded_at,
            self.date,
            format_amount(self.amount),
            self.currency,
            csv_safe(self.category),
            csv_safe(self.description),
            csv_safe(self.method),
            csv_safe(self.tags),
            self.source,
        ]

    def to_json(self) -> dict:
        data = {name: getattr(self, name) for name in FIELDS}
        data["amount"] = format_amount(self.amount)
        return data

    @property
    def month(self) -> str:
        return self.date[:7]


@contextmanager
def _file_lock(path: Path):
    """Cross-process lock so two portal instances cannot interleave writes."""
    if fcntl is None:  # pragma: no cover - Windows
        yield
        return
    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class Ledger:
    """All access to the CSV file goes through here."""

    def __init__(self, path: os.PathLike | str) -> None:
        self.path = Path(path).expanduser()
        self._thread_lock = threading.Lock()

    # -- reading ---------------------------------------------------------
    def ensure(self) -> None:
        """Create the file with a header if it does not exist yet."""
        if self.path.exists():
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._thread_lock, _file_lock(self.path):
            if self.path.exists():
                return
            self._atomic_write([])

    def read_with_problems(self) -> tuple[list[Entry], list[dict]]:
        """Return (entries, problems). A row we cannot parse is reported, never
        dropped in silence - losing a line of a money file must be visible."""
        if not self.path.exists():
            return [], []
        entries: list[Entry] = []
        problems: list[dict] = []
        with self.path.open("r", newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            for line_no, row in enumerate(reader, start=2):
                if not row or not any((value or "").strip() for value in row.values()):
                    continue
                try:
                    entries.append(Entry.from_row(row))
                except ValidationError as exc:
                    problems.append({"line": line_no, "field": exc.field, "error": exc.message})
        entries.sort(key=lambda item: (item.date, item.recorded_at))
        return entries, problems

    def read_all(self) -> list[Entry]:
        """Every entry, oldest first."""
        return self.read_with_problems()[0]

    def find(self, entry_id: str) -> Entry | None:
        return next((item for item in self.read_all() if item.id == entry_id), None)

    # -- writing ---------------------------------------------------------
    def append(self, entry: Entry) -> Entry:
        """Append one entry. Re-posting the same id is a no-op, not a duplicate."""
        with self._thread_lock, _file_lock(self.path):
            for existing in self.read_all():
                if existing.id == entry.id:
                    return existing
            needs_header = not self.path.exists() or self.path.stat().st_size == 0
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle, lineterminator="\n")
                if needs_header:
                    writer.writerow(FIELDS)
                writer.writerow(entry.to_row())
                handle.flush()
                os.fsync(handle.fileno())
        return entry

    def delete(self, entry_id: str) -> Entry | None:
        """Remove one entry, rewriting the file atomically."""
        with self._thread_lock, _file_lock(self.path):
            entries = self.read_all()
            remaining = [item for item in entries if item.id != entry_id]
            if len(remaining) == len(entries):
                return None
            removed = next(item for item in entries if item.id == entry_id)
            self._atomic_write(remaining)
        return removed

    def _atomic_write(self, entries: list[Entry]) -> None:
        """Write header + rows to a temp file, fsync, then rename over the target."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(FIELDS)
        for entry in entries:
            writer.writerow(entry.to_row())
        with tmp_path.open("w", newline="", encoding="utf-8") as handle:
            handle.write(buffer.getvalue())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, self.path)
        dir_fd = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


# -- reporting -----------------------------------------------------------
def filter_entries(
    entries: list[Entry],
    *,
    month: str | None = None,
    category: str | None = None,
    query: str | None = None,
) -> list[Entry]:
    result = entries
    if month:
        if not re.fullmatch(r"\d{4}-\d{2}", month):
            raise ValidationError("month", "month must look like 2026-09")
        result = [item for item in result if item.month == month]
    if category:
        wanted = category.strip().lower()
        result = [item for item in result if item.category == wanted]
    if query:
        needle = query.strip().lower()
        result = [
            item
            for item in result
            if needle in item.description.lower()
            or needle in item.category.lower()
            or needle in item.tags.lower()
        ]
    return result


def summarise(entries: list[Entry], *, today: dt.date | None = None, months: int = 6) -> dict:
    """Totals the portal shows: today, this month, per month, per category."""
    today = today or dt.date.today()
    this_month = today.strftime("%Y-%m")
    per_month: dict[str, Decimal] = {}
    per_category: dict[str, Decimal] = {}
    total = Decimal("0")
    today_total = Decimal("0")
    for entry in entries:
        total += entry.amount
        per_month[entry.month] = per_month.get(entry.month, Decimal("0")) + entry.amount
        if entry.month == this_month:
            per_category[entry.category] = per_category.get(entry.category, Decimal("0")) + entry.amount
        if entry.date == today.isoformat():
            today_total += entry.amount
    recent_months = sorted(per_month)[-months:]
    month_total = per_month.get(this_month, Decimal("0"))
    days_elapsed = today.day
    return {
        "count": len(entries),
        "total": format_amount(total),
        "today": format_amount(today_total),
        "month": this_month,
        "month_total": format_amount(month_total),
        "month_daily_average": format_amount(
            (month_total / days_elapsed) if days_elapsed else Decimal("0")
        ),
        "by_month": [{"month": key, "total": format_amount(per_month[key])} for key in recent_months],
        "by_category": [
            {"category": key, "total": format_amount(value)}
            for key, value in sorted(per_category.items(), key=lambda kv: kv[1], reverse=True)
        ],
    }
