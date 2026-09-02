# Money Portal

A small self-hosted web portal for recording what you spend, backed by one CSV
file. Type the number on your phone, the ledger gets a new row, and (optionally)
git gets a commit. No accounts, no cloud, no dependencies beyond Python 3.9+.

The CSV stays the source of truth — you can still open it in any spreadsheet,
`grep` it, or throw this tool away later without losing anything.

```
tools/money-portal/
├── server.py              # entry point: python3 server.py
├── moneytrack/            # ledger, HTTP API, git sync, importer
├── static/                # the portal page (vanilla HTML/CSS/JS)
├── tests/                 # 64 unit + end-to-end tests
├── deploy/                # systemd unit for the Raspberry Pi
└── run_tests.sh
```

## Quick start

```bash
cd tools/money-portal
python3 server.py
# ledger   /home/you/.money-portal/ledger.csv (0 entries)
# local    http://127.0.0.1:8787/
```

Open <http://127.0.0.1:8787/>, type an amount, press **Add entry**.

## Use it from your phone on the home network

```bash
python3 server.py --host 0.0.0.0 --token "$(openssl rand -hex 12)"
# network  http://192.168.1.42:8787/
```

Open that address on the phone; it asks for the token once and remembers it.
The server **refuses** to listen on a non-loopback address without a token —
otherwise anybody on the wifi could add or delete rows. Pass `--allow-open` if
you really want it open on a network you trust.

This is plain HTTP, so keep it on the LAN. If you want it from outside the
house, put it behind Tailscale or a reverse proxy that terminates TLS — do not
forward port 8787 on the router.

## Run it on the Raspberry Pi

```bash
sudo cp deploy/money-portal.service /etc/systemd/system/
sudoedit /etc/systemd/system/money-portal.service   # user, paths, token
sudo systemctl daemon-reload && sudo systemctl enable --now money-portal
```

## Keeping the numbers in git

`--git-sync` commits the ledger after every write; `--git-push` also pushes.
Both are off by default and neither can fail a save: if git errors, the row is
already in the CSV and the portal shows `git failed`.

**Point the ledger at a private repository.** The default lives in
`~/.money-portal/`, outside this repo on purpose — `yaolinge.github.io` is
published to the public web, so a ledger committed here would be readable by
anyone. To version the numbers:

```bash
python3 server.py --ledger ~/private-notes/money/ledger.csv --git-sync --git-push
```

## Importing the CSV you already keep by hand

```bash
python3 -m moneytrack.migrate example-old-ledger.csv                    # dry run
python3 -m moneytrack.migrate example-old-ledger.csv --out ~/.money-portal/ledger.csv
```

Columns are matched loosely, in English and Norwegian (`Dato`/`Date`,
`Beløp`/`Amount`/`Cost`, `Kategori`/`Type`, `Kommentar`/`Note`). Amounts written
as `149,90`, `1 250,00`, `kr 99` or `99,-` all parse. Rows it cannot read are
listed by line number instead of being silently dropped.

## The ledger format

```csv
id,recorded_at,date,amount,currency,category,description,method,tags,source
69fd0d34…,2026-09-02T07:24:30+00:00,2026-09-02,149.90,NOK,groceries,"Rema 1000, kaffe",vipps,,portal
```

* `id` — random hex; re-posting the same id is ignored, so a double-tap on a
  flaky phone connection cannot charge you twice.
* `amount` — always two decimals, rounded half-up. Money is handled with
  `Decimal` throughout; floats never touch it.
* `source` — `portal`, `import`, `cli` or `scan` (see the roadmap).

Text is sanitised before it is written: newlines are collapsed (they would split
a row) and a leading `=`, `+`, `-` or `@` is prefixed with `'` so a spreadsheet
cannot execute a note as a formula. The portal strips that apostrophe back off
when it displays the entry.

## HTTP API

Everything the page does is available directly, which is also how a future
receipt scanner will post.

| Method   | Path                | Purpose                                    |
|----------|---------------------|--------------------------------------------|
| `GET`    | `/api/config`       | currency, categories, methods, ledger path  |
| `GET`    | `/api/entries`      | `?month=2026-09&category=&q=&limit=`        |
| `POST`   | `/api/entries`      | `{"amount":"149,90","category":"groceries"}`|
| `DELETE` | `/api/entries/<id>` | remove one row                              |
| `GET`    | `/api/summary`      | totals per month and category               |
| `GET`    | `/healthz`          | liveness, no token needed                   |

```bash
curl -X POST http://127.0.0.1:8787/api/entries \
     -H 'X-Money-Token: your-token' -H 'Content-Type: application/json' \
     -d '{"amount":"149,90","category":"groceries","description":"Rema 1000"}'
```

Only `amount` is required. `date` accepts `YYYY-MM-DD`, `today` or `yesterday`
and defaults to today. Bad input comes back as `400` naming the offending field.

## Configuration

| Flag | Environment variable | Default |
|------|----------------------|---------|
| `--ledger` | `MONEY_LEDGER` | `~/.money-portal/ledger.csv` |
| `--host` | `MONEY_HOST` | `127.0.0.1` |
| `--port` | `MONEY_PORT` | `8787` |
| `--token` | `MONEY_TOKEN` | none |
| `--git-sync` | `MONEY_GIT_SYNC` | off |
| `--git-push` | `MONEY_GIT_PUSH` | off |
| — | `MONEY_CURRENCY` | `NOK` |
| — | `MONEY_CATEGORIES` | comma-separated list |
| — | `MONEY_METHODS` | comma-separated list |

Flags win over environment variables.

## Tests

```bash
./run_tests.sh          # or: python3 -m unittest discover -s tests -t tests
```

64 tests, under a second, no network and no fixtures to install. They cover
amount and date parsing, CSV round-trips, formula-injection escaping, atomic
delete, duplicate suppression, the HTTP API (against a real server on a random
port), token auth, path traversal, git sync in a throw-away repository, and the
importer.

## Roadmap: scanning instead of typing

The API is the seam for it. A scanner — a phone camera page, or a folder the Pi
watches — extracts the total and posts the same JSON with `"source": "scan"`,
so nothing below the API changes. The pieces still to build are the capture
page, the OCR step, and a confirmation screen before the row is written; guessed
amounts should never be committed unreviewed.
