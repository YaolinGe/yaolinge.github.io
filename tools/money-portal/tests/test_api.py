"""End-to-end tests against a real HTTP server on a throw-away port."""

import json
import threading
import urllib.error
import urllib.request

from support import TempLedgerCase  # noqa: E402  (sets sys.path)

from moneytrack.api import build_server  # noqa: E402
from moneytrack.config import Config  # noqa: E402
from moneytrack.gitsync import GitSync  # noqa: E402
from moneytrack.ledger import Ledger  # noqa: E402


class ServerCase(TempLedgerCase):
    token = ""

    def setUp(self):
        super().setUp()
        self.config = Config(ledger_path=self.ledger_path, host="127.0.0.1", port=0, token=self.token)
        self.ledger = Ledger(self.ledger_path)
        self.ledger.ensure()
        self.server = build_server(self.config, self.ledger, GitSync(self.ledger_path, enabled=False))
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        # Short poll interval: shutdown() otherwise waits up to the 0.5s default.
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        # Cleanups run last-registered-first: shutdown, then join, then close.
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.shutdown)

    def call(self, path, method="GET", body=None, token=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if token or self.token:
            request.add_header("X-Money-Token", token or self.token)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")


class ApiTests(ServerCase):
    def test_health_and_config(self):
        status, payload = self.call("/healthz")
        self.assertEqual((status, payload["ok"]), (200, True))
        status, payload = self.call("/api/config")
        self.assertEqual(status, 200)
        self.assertEqual(payload["currency"], "NOK")
        self.assertIn("groceries", payload["categories"])

    def test_post_then_read_back(self):
        status, payload = self.call(
            "/api/entries",
            "POST",
            {"amount": "149,90", "category": "Groceries", "description": "Rema 1000", "date": "2026-01-05"},
        )
        self.assertEqual(status, 201)
        self.assertEqual(payload["entry"]["amount"], "149.90")
        self.assertEqual(payload["entry"]["category"], "groceries")
        self.assertEqual(payload["summary"]["count"], 1)

        status, payload = self.call("/api/entries")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["entries"]), 1)
        self.assertEqual(payload["entries"][0]["description"], "Rema 1000")

    def test_entries_come_back_newest_first(self):
        for date in ["2026-01-01", "2026-03-01", "2026-02-01"]:
            self.call("/api/entries", "POST", {"amount": "10", "date": date})
        _, payload = self.call("/api/entries")
        self.assertEqual([item["date"] for item in payload["entries"]], ["2026-03-01", "2026-02-01", "2026-01-01"])

    def test_bad_input_is_a_400_naming_the_field(self):
        for body, field in [
            ({"amount": "abc"}, "amount"),
            ({"amount": "-5"}, "amount"),
            ({}, "amount"),
            ({"amount": "5", "date": "31-12-2026"}, "date"),
            ({"amount": "5", "currency": "kroner"}, "currency"),
        ]:
            with self.subTest(body=body):
                status, payload = self.call("/api/entries", "POST", body)
                self.assertEqual(status, 400)
                self.assertEqual(payload["field"], field)
        self.assertEqual(self.ledger.read_all(), [])

    def test_malformed_json_is_rejected(self):
        request = urllib.request.Request(self.base + "/api/entries", data=b"{not json", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(caught.exception.code, 400)

    def test_resending_the_same_id_does_not_double_charge(self):
        body = {"id": "fixedid", "amount": "99"}
        self.call("/api/entries", "POST", body)
        status, payload = self.call("/api/entries", "POST", body)
        self.assertEqual(status, 201)
        self.assertEqual(payload["summary"]["count"], 1)
        self.assertEqual(payload["summary"]["total"], "99.00")

    def test_delete(self):
        _, created = self.call("/api/entries", "POST", {"amount": "10"})
        entry_id = created["entry"]["id"]
        status, payload = self.call(f"/api/entries/{entry_id}", "DELETE")
        self.assertEqual(status, 200)
        self.assertEqual(payload["summary"]["count"], 0)
        status, _ = self.call(f"/api/entries/{entry_id}", "DELETE")
        self.assertEqual(status, 404)

    def test_month_filter_and_search(self):
        self.call("/api/entries", "POST", {"amount": "10", "date": "2026-01-05", "description": "coffee"})
        self.call("/api/entries", "POST", {"amount": "20", "date": "2026-02-05", "description": "skis"})
        _, payload = self.call("/api/entries?month=2026-02")
        self.assertEqual(len(payload["entries"]), 1)
        self.assertEqual(payload["entries"][0]["description"], "skis")
        _, payload = self.call("/api/entries?q=coffee")
        self.assertEqual(len(payload["entries"]), 1)
        status, payload = self.call("/api/entries?month=nonsense")
        self.assertEqual((status, payload["field"]), (400, "month"))

    def test_summary_endpoint(self):
        self.call("/api/entries", "POST", {"amount": "10", "date": "2026-01-05"})
        status, payload = self.call("/api/summary")
        self.assertEqual((status, payload["total"]), (200, "10.00"))

    def test_unparseable_rows_are_reported_to_the_client(self):
        self.call("/api/entries", "POST", {"amount": "10"})
        with self.ledger_path.open("a") as handle:
            handle.write("x,,2026-01-01,oops,NOK,x,,,,portal\n")
        _, payload = self.call("/api/entries")
        self.assertEqual(len(payload["problems"]), 1)

    def test_unknown_endpoints_and_static_traversal(self):
        self.assertEqual(self.call("/api/nope")[0], 404)
        self.assertEqual(self.call("/api/nope", "POST", {})[0], 404)
        self.assertEqual(self.call("/../../etc/passwd")[0], 404)
        self.assertEqual(self.call("/%2e%2e/%2e%2e/etc/passwd")[0], 404)

    def test_portal_files_are_served(self):
        with urllib.request.urlopen(self.base + "/", timeout=10) as response:
            page = response.read().decode()
        self.assertIn("Money Portal", page)
        with urllib.request.urlopen(self.base + "/app.js", timeout=10) as response:
            self.assertEqual(response.headers["Content-Type"].split(";")[0], "text/javascript")


class TokenTests(ServerCase):
    token = "s3cret"

    def test_api_needs_the_token(self):
        status, _ = self.call("/api/entries", token="wrong")
        self.assertEqual(status, 401)
        status, _ = self.call("/api/entries", "POST", {"amount": "10"}, token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(self.call("/api/entries")[0], 200)

    def test_health_stays_open_for_monitoring(self):
        request = urllib.request.Request(self.base + "/healthz")
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
