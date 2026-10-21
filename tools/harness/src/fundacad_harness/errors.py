class HarnessError(Exception):
    """A harness call that did not do what was asked. `str()` is one line."""

    def __init__(self, message: str, candidates: list[str] | None = None):
        self.candidates = list(candidates or [])
        if self.candidates and self.candidates[0] not in message:
            message = f"{message}: did you mean {', '.join(self.candidates[:8])}"
        super().__init__(message)


class LaunchError(HarnessError):
    """The engine, vite or the browser did not start. Carries the log tail."""

    def __init__(self, message: str, log_tail: str = ""):
        self.log_tail = log_tail
        super().__init__(message + (f"\n{log_tail}" if log_tail else ""))


class DriverMismatch(HarnessError):
    pass


class NotFound(HarnessError):
    pass


class Ambiguous(HarnessError):
    pass


class Disabled(HarnessError):
    pass


class Occluded(HarnessError):
    pass


class SettleTimeout(HarnessError):
    pass


class BadArgs(HarnessError):
    pass


class StepFailed(HarnessError):
    pass


KINDS = {
    "NotFound": NotFound,
    "Ambiguous": Ambiguous,
    "Disabled": Disabled,
    "Occluded": Occluded,
    "SettleTimeout": SettleTimeout,
    "BadArgs": BadArgs,
}
