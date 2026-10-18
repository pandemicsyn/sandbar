---
"@sandbar-sdk/daytona": minor
"@sandbar-sdk/e2b": minor
---

Inspect, list and delete prepared images: Daytona maps native snapshots and E2B maps templates. Deletion refuses public or shared images, captured sandbox snapshots and images that sandboxes or warm pools still use before sending one unreplayed native delete. Built images now report a `reference` with verified ownership when the build's own request created them.
