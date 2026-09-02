"""Self-hosted money tracker: CSV ledger + tiny web portal.

The CSV file stays the source of truth so the data outlives this tool; the
portal only exists to stop humans hand-editing rows in a text editor.
"""

__all__ = ["config", "ledger", "api", "gitsync", "migrate"]
