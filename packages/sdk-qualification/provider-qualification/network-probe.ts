import { z } from "zod";
import type { AdapterSandbox } from "sandbar-sdk";
import type { FailureCapture } from "./diagnostics";

export const networkProbeId = "cloudflare-tcp443-hostname-ipv4-v1" as const;

const attempt = z
  .strictObject({
    target: z.enum(["hostname", "ipv4"]),
    connected: z.boolean(),
    error: z.enum(["timeout", "unreachable", "denied", "dns", "refused", "other"]).optional(),
  })
  .refine((entry) => entry.connected !== Boolean(entry.error), "Inconsistent connection outcome");

export const networkSampleSchema = z
  .strictObject({
    phase: z.enum(["before", "blocked", "after"]),
    attempts: z.tuple([attempt, attempt]),
  })
  .refine(
    (sample) => sample.attempts[0].target === "hostname" && sample.attempts[1].target === "ipv4",
    "Probe target order mismatch",
  );

export const networkEvidenceSchema = z.strictObject({
  probe: z.literal(networkProbeId),
  samples: z.array(networkSampleSchema).min(1).max(3),
});

export type NetworkSample = z.infer<typeof networkSampleSchema>;

export type NetworkEvidence = z.infer<typeof networkEvidenceSchema>;

// Fixed public destinations, no credentials or payload. TCP only: no claim about UDP, IPv6 or ingress.
export const networkScript = `import socket, errno, json
attempts = []
for target, host in [("hostname", "one.one.one.one"), ("ipv4", "1.1.1.1")]:
    result = {"target": target, "connected": False}
    try:
        address = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)[0][4]
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(address)
            result["connected"] = True
    except socket.gaierror:
        result["error"] = "dns"
    except TimeoutError:
        result["error"] = "timeout"
    except OSError as error:
        result["error"] = {errno.ENETUNREACH: "unreachable", errno.EHOSTUNREACH: "unreachable", errno.EACCES: "denied", errno.EPERM: "denied", errno.ECONNREFUSED: "refused"}.get(error.errno, "other")
    attempts.append(result)
print(json.dumps({"attempts": attempts}))
`;

export async function probeNetwork(
  sandbox: AdapterSandbox,
  phase: NetworkSample["phase"],
  capture: FailureCapture,
  signal?: AbortSignal,
): Promise<NetworkSample> {
  capture.at("exec");
  capture.networkPhase(phase);

  const result = await sandbox.exec(
    {
      command: { kind: "argv", argv: ["python3", "-c", networkScript] },
      deadlineSeconds: 20,
      maxOutputBytes: 4096,
    },
    { signal },
  );

  capture.output(result, "two complete TCP probe outcomes", "");

  if (result.truncated || result.exitCode !== 0 || result.stderr.length)
    throw new Error("Network probe did not complete cleanly");
  const sample = networkSampleSchema.parse({ ...JSON.parse(result.stdoutText()), phase });

  return sample;
}

export function requireInternet(sample: NetworkSample): void {
  if (sample.attempts.some((entry) => !entry.connected))
    throw new Error(`Internet positive control failed: ${JSON.stringify(sample)}`);
}

export function requireBlocked(sample: NetworkSample): void {
  if (
    sample.attempts.some(
      (entry) =>
        entry.connected || !["timeout", "unreachable", "denied"].includes(entry.error ?? ""),
    )
  )
    throw new Error(`Blocked TCP probe failed or was inconclusive: ${JSON.stringify(sample)}`);
}
