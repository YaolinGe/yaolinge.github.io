"""Errors shared by the ledger and the HTTP layer."""


class ValidationError(ValueError):
    """A submitted field is not usable. Carries the field name for the UI."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message

    def as_dict(self) -> dict:
        return {"error": self.message, "field": self.field}
