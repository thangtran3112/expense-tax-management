class ProviderError(Exception):
    """A data provider failed or is not configured: HTTP 502, never empty data."""


class Unsupported(Exception):
    """The request asks for data this service does not supply: HTTP 501."""
