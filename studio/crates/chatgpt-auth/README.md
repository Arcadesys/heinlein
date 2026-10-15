# Heinlein native ChatGPT sign-in

This crate implements the documented native/public-client Sign in with ChatGPT
flow. It does not issue inference requests, read another app's credentials, use
environment/API keys, or silently choose a billing path.

## Host integration

- Construct `AuthService::open(private_app_data_path)` outside repository roots.
  Unix descriptor-relative private storage is supported; other platforms fail
  closed. `open` and `status` make no network requests. The directory and lock
  may be created on open, but the stable host record is saved only when the user
  explicitly starts connection.
- An explicit user action calls `connect(saved_client_id_or_none, browser_opener)`.
  The native callback opens the system browser; never return its URL to renderer
  JavaScript or log it. Browser failure maps to `AuthError::Browser`.
- Present all `accounts`, including signed-out retained registrations. Use their
  exact ID for reauthorization. `None` explicitly registers a new account. A
  saved account's OAuth identity must match before credentials are replaced.
- `select_account` activates a signed-in saved registration and fetches its
  account-specific model catalog. A signed-out registration must use `connect`.
  `refresh_models` is explicit. Model visibility must be `list`; server ordering
  and slugs are preserved. No model is chosen automatically.
- `select_model` accepts only a catalog model. `credentials(expected_generation)`
  gives the native transport a non-serializable, non-debug secret lease. The
  caller must select on `cancelled` before transmission and throughout the
  request, and require `is_current(generation)` before publishing a result.
  Hold no tokens in renderer storage, logs, analytics, or messages.
- `cancel` immediately invalidates leases and pending sign-in. `sign_out` also
  clears local tokens and attempts bounded remote refresh-session revocation.
  A status warning reports unconfirmed remote revocation. Client/account/host
  registration survives; it is reused on the next sign-in.

The caller is responsible for explicit plan-usage consent and current manuscript
context/Send authorization. Accounts missing `chatgpt.tokens.use.direct` remain
signed in but cannot be used for model requests. The native inference transport
must use only `POST https://api.openai.com/v1/responses`, with `store:false`,
`stream:true`, and a terminal completed event. No fallback is authorized here.

## Security boundary

OAuth uses fresh state, nonce and S256 PKCE; an ephemeral IPv4 loopback listener
starts before opening the browser. Its exact `/auth/callback` URI is reused for
token exchange. Only one valid callback is consumed; malformed requests,
duplicate parameters, wrong host/path/method/state, and swapped client IDs fail
closed. Listener lifetime is five minutes; individual sockets are bounded.
Issued client IDs are durably retained before exchanging a code.

ID tokens use maintained `jsonwebtoken` RS256 verification, a unique matching
OpenAI JWKS key, issuer/audience/authorized-party/subject/expiration/issued-at and
fresh sign-in nonce validation. A returning account's subject cannot change.
HTTP uses fixed HTTPS endpoints with no proxies, redirects, or automatic retries,
and bounded response sizes and timeouts. Only static safe errors leave the crate.

The 0700 directory, 0600 regular records/lock, owning UID, single hardlink, and
all path components are checked. Atomic writes fsync the record and directory.
Descriptor-relative opens reject symlinks, replacement races, and special files.
A nonblocking owned flock serializes rotating refresh across processes; busy
callers retry later. A durable write-ahead refresh marker prevents reusing a
possibly consumed token after a crash, lost response, or failed replacement.
Such sessions require explicit reauthorization with the saved registration;
identity is retained and status does not advertise them as usable. JWKS is
fetched before a refresh token is consumed. Ambiguous network/5xx failures preserve credential material while requiring fresh
authorization; terminal refresh errors clear unusable tokens.

Locks protect cooperating native processes, not an attacker controlling the
same OS account. Global revocation of already transmitted requests is impossible;
in-process generation/watch cancellation prevents subsequent native transmission
and stale result publication. The caller owns request cancellation during app
shutdown. Cross-process sign-out is observed on the next credential acquisition.

## Offline verification

`cargo test -p heinlein-chatgpt-auth` uses synthetic credentials, a disposable
published test signing key, fake transport responses, temporary directories and
loopback callback sockets only. It never contacts OpenAI, starts a real browser,
reads real credentials, registers an app, or consumes model usage. See the test
fixture README for the deliberately public test private key.

Official flow documentation:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
