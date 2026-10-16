# Rate limits — Square (orders/payments/payouts polling)

Vendor docs are authoritative. Every figure below carries its source URL.
Anything we could not verify in vendor docs is marked **UNVERIFIED** — never
guessed.

## No published numeric limits

Square **does not publicly disclose numeric rate limits** (no documented
requests/second per endpoint). The vendor's standing guidance is to handle
throttling gracefully with retries, exponential backoff, and jitter —
not to pace against a fixed number.

- Source: <https://developer.squareup.com/forums/t/current-square-api-rate-limit/449>
  (vendor-staff answers: "we currently do not publicly disclose the rate
  limits"; "we encourage you to handle the limit gracefully by building a
  retry mechanism … exponential backoff … randomness")
- **UNVERIFIED**: any fixed QPS/RPS figure for `SearchOrders`,
  `ListPayments`, or `ListPayoutEntries`. Do not hard-code one.

## Throttling signal

- When an app sends too many requests in a short period, Square returns
  **`429 Too Many Requests`** with a **`RATE_LIMITED`** error category.
  - Source: <https://developer.squareup.com/docs/build-basics/general-considerations/handling-errors>
  - Category reference: <https://developer.squareup.com/reference/square/objects/ErrorCategory>
- On `429`, the vendor prescribes: retry with an **exponential backoff
  schedule at an increasingly slower rate**, plus **randomized delay
  (jitter)** to avoid a thundering-herd effect.
  - Source: <https://developer.squareup.com/docs/build-basics/general-considerations/handling-errors>
- The Square SDKs include built-in retry support for throttled requests
  (vendor confirms retries on `429`/`503`/`500` with configurable
  backoff); details vary by SDK.
  - Source: <https://developer.squareup.com/forums/t/rate-limited-resolution/11640>
- **UNVERIFIED**: whether throttled core-API responses (`SearchOrders`,
  `ListPayments`, payouts) carry a `Retry-After` header. Vendor docs
  direct callers to respect `Retry-After` for the Reporting API
  (source: <https://developer.squareup.com/docs/reporting-api/error-handling>)
  and vendor forum guidance mentions retrying "according to the
  `Retry-After` header" (source: <https://developer.squareup.com/forums/t/reporting-api-for-sales-summary/6988>),
  but header presence on the sales APIs this package uses is **not
  documented** — code must honor it when present and fall back to
  exponential backoff with jitter when absent.
- **UNVERIFIED**: rate-limit response-header names/units
  (`X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`)
  sometimes quoted for Square — vendor-confirmed only via a community
  forum reply, not vendor docs. Do not depend on them.

## List-loop guidance (this package)

Per the vendor's handling-errors page
(<https://developer.squareup.com/docs/build-basics/general-considerations/handling-errors>):

- Prefer **`Batch`/`Bulk` endpoints** where available to collapse many
  operations into one request.
- Use **filters** on `Search`/`List` endpoints (location IDs, date-time
  windows) so each call returns only the data needed — this package's
  window import already scopes by location + `startAt`/`endAt`.
- Follow **cursor pagination** (`cursor` in → `cursor` out); never
  re-request already-consumed pages.
- Put API calls behind a **worker queue** that centrally paces call
  frequency and re-queues `429` tasks for later retry with increasing
  intervals — "particularly useful for API calls that are prone to rate
  limiting … and critical operations".

## HOST_CHECKLIST

- [ ] Jittered backoff: on `429 RATE_LIMITED`, re-queue with exponential
      backoff plus random jitter at increasingly slower rates; never
      tight-loop.
- [ ] Retry-After respect: if the `429` response carries a `Retry-After`
      (or equivalent wait directive), wait that long before retrying;
      otherwise use the backoff schedule. Presence is UNVERIFIED — handle
      both cases.
- [ ] Per-tenant serialization: one list-loop per merchant (location set)
      at a time via a central worker queue; narrow every loop with
      location + time filters and cursor pagination.
- [ ] Alerting: log `429` rates per endpoint (`SearchOrders`,
      `ListPayments`, `ListPayoutEntries`); alert on rising throttles
      (means windows too wide or queue pacing too aggressive) and on
      repeated retries of the same cursor (means stuck loop).
