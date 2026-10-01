# Plans

The [roadmap](../ROADMAP.md) controls the current queue. Snapshot/volume support (#25), provider acceptance (#32) and recovery results/resource identities (#33) are merged. Cleanup configuration, public types/errors and lifecycle reopen/inspect are delegated implementation work; streaming/cancellation is delegated scoping only. None of those delegated tasks is implemented until merged. New providers and service expansion remain behind SDK usability.

The [implementation sequence](implementation-plan.md) records delivery boundaries, and the [provider acceptance plan](provider-acceptance.md) records the merged Bun runner direction. Engineering contracts and proposals live in [specs](../specs/README.md), public documentation in [apps/docs](../apps/docs/README.md), and qualification guidance [with its harness](../packages/sdk-qualification/README.md).

Completed and superseded plans remain in Git history; they do not define current requirements or release gates.
