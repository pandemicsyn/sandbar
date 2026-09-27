import { z } from "zod";
import { defineAdapter } from "@sandbar/adapter";

/** Simulated durable provider job boundary for the asynchronous recovery guide. */
const jobs = new Map<string, { operationId: string; image: string; sandboxId: string }>();
export const metrics = { submits: 0, observes: 0 };
const Token = z.strictObject({ jobId: z.string().min(1) });

export const asyncAcme = defineAdapter({
  name: "example.async-acme",
  config: z.strictObject({ region: z.string().min(1) }),
  credentials: z.strictObject({ token: z.string().min(1) }),
  async connect({ config, credentials }) {
    if (credentials.token !== "fixture-token") throw new Error("Invalid fixture credential");
    return {
      scope: { authority: { kind: "account", id: "account-1" }, partition: { region: config.region } },
      supports: { images: ["prepared"], network: ["blocked"] },
      create: {
        recovery: { version: 1, token: Token },
        async prepare(input) {
          if (input.image.kind !== "prepared") throw new Error("Only prepared images are available");
          return { image: input.image.value };
        },
        async submit(input, ctx) {
          metrics.submits++;
          const jobId = `job-${ctx.submissionId}`;
          jobs.set(jobId, { operationId: ctx.operationId, image: input.image, sandboxId: `box-${ctx.submissionId}` });
          return ctx.pending({ jobId }, { pollAfterMs: 500 });
        },
        async observe(attempt) {
          metrics.observes++;
          const token = Token.parse(attempt.token);
          const job = jobs.get(token.jobId);
          if (!job || job.operationId !== attempt.operationId || job.image !== "image-123") return null;
          return { id: job.sandboxId, state: "running" as const };
        },
      },
      async destroy() { return { computeStopped: true, retainedResources: [] }; },
    };
  },
});
