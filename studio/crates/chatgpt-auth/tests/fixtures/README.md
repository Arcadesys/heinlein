# Synthetic cryptographic test fixtures

`test-only-rsa-key.der` is a freshly generated, disposable 2048-bit RSA private
key in PKCS#1 DER format. `test-only-jwks.json` contains its matching public key.
They were generated solely for this crate's offline/mock tests and are safe to
publish. They are not OpenAI keys, user credentials, or production secrets.

Only `src/tests.rs` includes the private fixture, behind `#[cfg(test)]`. Production
authentication reads OpenAI's published JWKS over pinned HTTPS endpoints and has
no path to this key. Never use this public test private key for real accounts,
services, signing, encryption, or persisted credentials.
