---
title: Adapter capability checklist
description: Declare only native guarantees that the adapter can actually enforce.
---

| Capability | Provider obligation                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Create     | Verify image/account/region and network isolation before one native submission. Correlate the returned sandbox to the attempt.         |
| Destroy    | Attempt native compute cleanup; report `computeStopped: true` only after confirmation.                                                 |
| Scope      | Authenticate authority and include every routing partition that changes native resource identity. Check it on every read and mutation. |
| Exec       | Declare `argv` and/or `shell` accurately. Preserve binary stdout/stderr and apply the combined output bound. Disable hidden retries.   |
| Files      | Enforce byte bounds. Offer `overwrite: false` only with native atomic no-clobber semantics.                                            |
| Inventory  | Paginate and verify listed resource ownership, including detail reads when list payloads omit scope.                                   |
| Recovery   | Observe a previous submission without starting it again. Validate token version and native resource/operation correlation.             |
| Close      | Release owned local clients exactly once. Never imply that close or abort destroyed remote compute.                                    |

`adapterSuite` from `sandbar-adapter/testing` exercises required managed-compute scenarios and reports which ran. The provider adapters run this suite against deterministic native boundaries. The fake provider is a test simulation, not an isolated execution environment. The suite does not certify an external provider's behavior by itself; its fixture must demonstrate that the native transport makes one outbound mutation attempt.

## State portability checks

Direct and service clients expose asynchronous `client.capabilities()` and `box.capabilities()` observations, plus read-only request evaluation:

```ts
const check = await client.sandboxes.checkCreate({
  environment: Image.prepared("your-image-id"),
  requirements: { snapshot: { requirements: { preserve: "filesystem" } } },
});
if (check.status === "supported") {
  console.log(check.value.snapshot);
}
```

`checkSnapshot()` resolves the configured native default. Optional `requirements` validate its preservation, interruption, source lifecycle and consistency without selecting another profile. The profile and artifact metadata report fresh or resumed execution and unknown consistency where evidence is unavailable. The four statuses distinguish implemented support, unsupported combinations, unavailable access/state, and unknown evidence. Unknown state or retention cannot satisfy hard requirements. Supported checks report mount handling, retention evidence, manual cleanup, and explicitly unknown restore restrictions. They never build images, allocate probe resources, stop compute, or dispatch capture.

Requirements are rechecked during create preparation and before submission. Unsupported requests fail before allocation; unknown and unavailable requirements also block allocation. The service checks requirements before admission and the runner checks the persisted requirement again. Service connection checks use the first verified installed connection in creation order; a scoped prepared image selects its bound connection for create checks. No automatic provider switching is performed.

Daytona and E2B direct connections implement distinct capture/restore and retained volume profiles; read [Snapshots and volumes](/docs/guides/snapshots-and-volumes/) for their limits. Suspension and volume versions remain unsupported. The service capability contract reports state resource operations unsupported because it exposes no corresponding endpoints. The asynchronous direct capability getter is an intentional API change; callers must await it.

Preparation validates requirements before the durable submission marker, then read-only eligibility is checked again before dispatch. Recovery only observes native evidence. For a source already observed as stopped, a profile ending stopped satisfies unchanged lifecycle state.
