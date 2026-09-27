# Observability, usage, and accounting

Draft 0.3 · Proposed v1 contracts after three rounds of accounting and telemetry critique

## Three separate planes

| Plane | Purpose | Reliability contract |
|---|---|---|
| Operational telemetry | Traces, logs, resource samples, service health | Bounded best effort; sampling/drop/gaps visible |
| Usage evidence | Resource transitions, observations, allocation and consumption evidence | Durable unsampled records; source accuracy/completeness remains explicit |
| Cost accounting | Rate-based estimates, provider reports, invoice records | Versioned bases and corrections with explainable provenance |

Do not reconstruct billing from sampled traces or a CPU dashboard. Durable evidence is not automatically invoice authority: even native observations may be delayed or coarse. Guest-reported measurements and SDK baggage are untrusted workload telemetry, not authoritative tenant attribution or billable usage.

V1 provides operational visibility, showback, cost exports, and hooks for downstream billing. Defer customer invoice generation, payment collection, revenue markups, and arbitrary custom-meter ingestion. A future metering API would require registered source principals, units, delta/cumulative behavior, lateness rules, and dedupe semantics.

## Operational telemetry

Instrument request, operation, sandbox, connection, preparation/build, checkpoint, volume, transfer, and cleanup phases. Carry correlation IDs in traces/log records; keep default metric dimensions low-cardinality. Do not use every sandbox/operation/user ID as a default time-series dimension. Guest attributes cannot override server-authoritative project or accounting scope.

Ship structured logs and health metrics without requiring an external backend. The management UI uses operation history, latest provider resource readings, and an optional bounded recent-sample window. Proposed local window: at most one sample/minute for one hour, subject to configured byte/cardinality quotas and source availability. Show missing/stale readings. This is not an internal general-purpose OpenTelemetry database.

Optional OTLP export supports external systems. Qualify exporters and instrumentation on the selected Bun runtime; do not assume Node auto-instrumentation works unchanged. Configure sampling explicitly. Long operations use linked phase/attempt spans plus stable operation IDs rather than a single in-memory span surviving a process restart.

Default metadata excludes secret values, raw command text/argv/shell strings, command environment, signed URLs, registry credentials, file content, and command output. Command/build output is a separately authorized retained artifact. Provider-native or guest telemetry can contain sensitive data; apply independent destinations, authorization, quotas, and retention.

TelemetryDriver can read available resource metrics/logs and describe their source/units/timestamps. Reconfiguring an account-wide provider exporter requires explicit operator action, never a connection verification side effect. Daytona documents distinct SDK/runtime telemetry paths and native history endpoints; this is enrichment rather than the basis for Sandbar's operation journal. [Daytona telemetry](https://www.daytona.io/docs/en/observability/otel-collection/)

OTel trace sampling and metric cardinality limits are reasons to keep evidence capture independent of exporters. A telemetry sink outage may drop bounded telemetry with counters, but must not silently discard usage evidence or block cleanup. [OTel sampling](https://opentelemetry.io/docs/concepts/sampling/), [OTel metric limits](https://opentelemetry.io/docs/specs/otel/metrics/sdk/)

## Usage evidence and derived records

Record relevant state changes and evidence atomically with local resource updates. Persist native event effective time, observed time, and local recorded time independently. Requests, acceptance, provisioning, usable runtime, paused storage, and observed deletion are different boundaries.

Conceptual evidence:

```json
{
  "id": "ue_...",
  "source": {
    "kind": "provider",
    "scopeId": "scope_...",
    "eventKey": "native-event-id",
    "revision": "2"
  },
  "resourceId": "sb_...",
  "effectiveAt": "2026-09-26T12:00:00Z",
  "observedAt": "2026-09-26T12:00:05Z",
  "recordedAt": "2026-09-26T12:00:05Z",
  "kind": "resource.state-observed",
  "payload": { "state": "running" }
}
```

Native timestamps can be unknown; do not manufacture exact times. Derived UsageRecord contains meter, decimal-string quantity, precise unit, interval, coverage (complete/bounded/unknown), evidence IDs, derivation version, and attribution revision. A server-observed running interval can support an estimate without becoming a provider-confirmed billable duration.

Missing intervals and prices remain unknown. Preserve native units: physical cores and vCPU, GB and GiB, allocation and measured consumption are not interchangeable labels. Use verified explicit conversions and retain their provenance.

Track independently:

- Active and transitional compute, reserved/burst resources, and provider-confirmed meters.
- Warm unclaimed pool capacity and claimed allocations.
- Build/import/preparation resources, cache outcomes, and failed attempts.
- Volumes, checkpoints, image storage, and retention after sandbox deletion.
- Transfer/egress/relay quantities where actually observable.
- Sandbar host/storage overhead as a separate cost source.

Modal charges based on the larger of requested and actual resources and uses physical CPU cores in native requests. Daytona uses reserved-resource state-dependent billing. A universal vCPU-count-times-wall-clock formula would therefore be misleading. [Modal resources](https://modal.com/docs/guide/sandbox-resources), [Daytona billing](https://www.daytona.io/docs/billing)

## Cost bases and query API

CostRecord includes basis, canonical source scope, source line or bucket identity, revision, charge period, decimal-string amount, currency, tax/credit treatment, optional rate version, allocation status, evidence references, and supersession/correction links.

Use exactly three cost bases:

- estimated: Sandbar calculation from declared evidence and a versioned rate card.
- provider_reported: imported provider usage/charge report, which may be provisional or gross.
- invoiced: imported invoice facts with their stated credit/tax treatment; not automatically paid.

Do not automatically blend, sum, or subtract overlapping bases. Query one basis at a time and show alternatives side by side. Missing evidence makes totals incomplete rather than zero. Currency totals remain separate unless an explicit versioned FX conversion is requested later.

```text
GET /v1/projects/{projectId}/usage?meter=...&groupBy=...
GET /v1/projects/{projectId}/costs?basis=estimated
GET /v1/projects/{projectId}/costs?basis=provider_reported
GET /v1/projects/{projectId}/accounting/events?cursor=...
```

Responses report currency, coverage, granularity, asOf, and attribution scope. Grouping dimensions are whitelisted. Query/export cursors are stable and return explicit expiry/gaps rather than silently starting from current time. Durable accounting events have stable IDs and at-least-once delivery; consumers deduplicate.

Proposed SDK query:

```ts
const costs = await client.costs.query({
  basis: "estimated",
  from: "2026-09-01T00:00:00Z",
  to: "2026-10-01T00:00:00Z",
  groupBy: ["costCenter", "provider"],
});
```

Python and Rust expose the same query concepts using native named arguments/builders. The SDK never calls an estimate an invoice or changes cost basis when a provider report is unavailable.

## Billing-account imports and authorization

Introduce operator-owned BillingAccountLink separately from project ProviderConnection. Inspect verified native billing scope and permissions. An execution key's incidental billing permission does not authorize automatic import of an entire provider account's bill.

Deduplicate by canonical verified provider billing account/workspace scope, not connection ID. Multiple project connections pointing at the same account must not duplicate cost. Full reports, billing-account metadata, and unallocated/shared costs are operator-only; project APIs expose only authorized allocations.

AccountingDriver is read-only and optional: inspect billing scope/permissions, discover available meters/rates, and fetch usage/charge records with source identity, periods, revisions, basis, and completeness. Sandbar owns imports, dedupe, allocation, corrections, and exports. A provider dashboard does not establish an API capability, and subscription restrictions remain visible.

For stable source-line revisions, append corrected evidence and supersede prior effective values. For snapshot reports, the driver declares canonical nonoverlapping bucket replacement semantics. Never sum arbitrary overlapping reports or hash an entire report and treat every changed report as new spend. Preserve source timezone and billing-period boundaries.

If native account identity cannot be verified, manual mapping is marked unverified and cannot support a claim of exact cross-connection dedupe.

Modal reports can be plan-gated, omit credits/reservations, and apply tags over queried intervals in ways that cannot establish historical ownership. Preserve Sandbar's own attribution and do not call gross report totals paid cost. [Modal billing](https://modal.com/docs/guide/billing), [Modal billing API/CLI](https://modal.com/docs/cli/latest/billing)

## Attribution and downstream billing

AccountingAssignment is an authorized, effective-dated owner/workload/cost-center relationship. Copy the accepted assignment revision into resource/evidence records. Arbitrary labels remain useful filters but are not authority to charge another owner. Tokens and project policy constrain permitted accounting references.

Reassignment/adoption creates a new effective interval; it does not rewrite old ownership. If a source charge is too coarse to split exactly, report the limit or use an explicitly configured allocation rule. Leave pool idle time, shared images/volumes, credits, and host overhead unallocated unless a disclosed rule assigns them.

Operator contract-rate overrides are useful estimates and belong in effective-dated RateCards. Customer resale tariffs are separate from provider cost and are deferred. Consider a later FOCUS export mapping after fields are verified; do not claim conformance merely from similar names. [FOCUS overview](https://focus.finops.org/what-is-focus/)

Correction example: two connections reference one workspace, and the same $10 line is imported twice. Effective provider-reported total remains $10. A revised source line changes it to $12; effective total becomes $12, not $22. A later invoice records $12 gross less $5 credit: invoiced net is $7 in the invoiced view, while the gross provider-reported view remains $12. No undisclosed proportional credit allocation occurs.

## Proposed retention and budgets

| Data | Default |
|---|---|
| Detailed normalized lifecycle/usage evidence | 90 days |
| Charges, referenced rates, attribution history, minimum explanatory provenance | 13 months |
| Aggregates | 13 months, with retained granularity reported |
| Original imported reports after successful normalization | 30 days unless preserved |
| Security audit metadata | 90 days |
| Local runtime debug logs | 24 hours or 100 MiB, whichever first |
| General trace/metric history | External OTLP backend when configured |

Retain the minimum evidence needed to explain every retained charge. Open/unresolved import or dispute evidence stays pinned and creates visible storage pressure. Deleting fine-grained history limits future reallocation; aggregates do not recreate missing per-resource detail. Provide operator storage quotas, export/archive tools, and reserved headroom for cleanup.

Budget policies can notify, gate new admissions, or apply verified native limits. They must not promise an exact dollar ceiling from delayed reports, burst billing, unknown provider outcomes, or retained storage. A budget breach never blocks inspection/reconciliation/cleanup. Accounting exporter failure is independent from core cleanup; a full database is a control-plane incident, not permission to drop required evidence silently.

## Release tests

Test same-account multi-project duplicate imports and privacy, overlapping windows, stale revisions, late credits, mixed currencies, GB/GiB and physical-core/vCPU conversion, missing intervals, changed attribution, coarse allocations, source/cursor expiration, guest attribute spoofing, sink outages, and atomic ledger/state writes through crash recovery.

The scope is reliable evidence and explainable reporting. No universal invoice-accuracy, downstream billing compliance, or provider-budget guarantee is implied.
