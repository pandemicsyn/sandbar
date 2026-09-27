import { z } from "zod";
import { AdapterError, defineAdapter, type CreateValue, type ExecValue } from "./index";

const native = {
  async whoami() { return { id: "account-1" }; },
  async spawn(imageId: string) { return { id: imageId, ready: true }; },
  async deleteAndWait(_id: string) {},
  async getSandbox(id: string) { return { id, running: true }; },
  async startJob(_sandboxId: string, _argv: string[]) { return { jobId: "job-1" }; },
  async findJob(_id: string) { return { done: false, id: "job-1" }; },
};

export const minimal = defineAdapter({
  name: "example.acme",
  config: z.strictObject({ region: z.string().min(1) }),
  credentials: z.strictObject({ token: z.string().min(1) }),
  async connect({ config, credentials, host }) {
    config.region satisfies string;
    credentials.token satisfies string;
    host.onClose(() => {});
    const account = await native.whoami();
    return {
      scope: { authority: { kind: "account", id: account.id }, partition: { region: config.region } },
      supports: { images: ["prepared"], network: ["blocked"] },
      async create(input, ctx) {
        const image = input.image.value;
        ctx.submissionId satisfies string;
        const box = await native.spawn(image);
        return { id: box.id, state: box.ready ? "running" : "unknown" };
      },
      async destroy(box, ctx) {
        ctx.submissionId satisfies string;
        await native.deleteAndWait(box.id);
        return { computeStopped: true, retainedResources: [] };
      },
    };
  },
});

export const advanced = defineAdapter({
  name: "example.advanced",
  config: z.strictObject({ region: z.string() }),
  credentials: z.strictObject({ token: z.string() }),
  async connect({ config, credentials }) {
    config.region satisfies string;
    credentials.token satisfies string;
    return {
      scope: { authority: { kind: "account", id: "account-1" }, partition: { region: config.region } },
      supports: {
        images: ["prepared"],
        network: ["blocked"],
        exec: { commands: ["argv"], maxOutputBytes: 1_048_576 },
      },
      async create(input, _ctx): Promise<CreateValue> {
        return { id: input.image.value, state: "running" };
      },
      async destroy(_box, _ctx) {
        return { computeStopped: true, retainedResources: [] };
      },
      exec: {
        recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
        async prepare(input, _read) {
          const box = await native.getSandbox(input.sandbox.id);
          if (!box.running) throw new Error("Not running");
          if (input.command.kind !== "argv") throw new AdapterError("UNSUPPORTED", "Only argv commands are supported");
          return { sandboxId: box.id, argv: input.command.argv };
        },
        async submit(input, ctx) {
          const reply = await native.startJob(input.sandboxId, input.argv);
          return ctx.pending({ jobId: reply.jobId });
        },
        async observe(attempt, ctx): Promise<ExecValue | null | ReturnType<typeof ctx.pending>> {
          const job = await native.findJob(attempt.sandbox.id);
          if (!job) return null;
          if (!job.done) return ctx.pending({ jobId: job.id });
          return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false };
        },
      },
    };
  },
});
