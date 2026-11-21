"""Pure signing-policy construction; no Keychain access or configuration writes.

This helper is deliberately not activated by the updater. A caller must first
securely load and validate an explicitly configured public certificate hash.
"""
import re

IDENTITY = re.compile(r"[0-9A-F]{40}\Z")
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]*\Z")


def signing_arguments(identity, identifier):
    """Build narrowly scoped codesign arguments, with no ad-hoc fallback."""
    if not isinstance(identity, str) or not IDENTITY.fullmatch(identity):
        raise ValueError("A specific certificate fingerprint is required")
    if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
        raise ValueError("Invalid code identifier")
    requirement = f'designated => identifier "{identifier}" and certificate leaf = H"{identity}"'
    return ["--force", "--sign", identity, "--timestamp=none", "--identifier", identifier,
            "--requirements", "=" + requirement]


def verification_arguments(identity, identifier):
    if not isinstance(identity, str) or not IDENTITY.fullmatch(identity):
        raise ValueError("A specific certificate fingerprint is required")
    if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
        raise ValueError("Invalid code identifier")
    requirement = f'identifier "{identifier}" and certificate leaf = H"{identity}"'
    return ["--verify", "--strict", "--verbose=2", "-R", "=" + requirement]
