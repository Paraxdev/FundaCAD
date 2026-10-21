"""Drive the FundaCAD browser build the way a person does."""

from .bridge import DRIVER_API
from .errors import (
    Ambiguous,
    BadArgs,
    Disabled,
    DriverMismatch,
    HarnessError,
    LaunchError,
    NotFound,
    Occluded,
    SettleTimeout,
    StepFailed,
)
from .session import Session

__version__ = "0.1.0"

__all__ = [
    "DRIVER_API",
    "Ambiguous",
    "BadArgs",
    "Disabled",
    "DriverMismatch",
    "HarnessError",
    "LaunchError",
    "NotFound",
    "Occluded",
    "Session",
    "SettleTimeout",
    "StepFailed",
    "__version__",
]
