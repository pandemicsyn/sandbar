import { z } from "zod";

export const ProcessReference = z.strictObject({
  version: z.literal(1),
  tag: z
    .string()
    .regex(/^sandbar-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  sandbox: z.string().min(1).max(128),
  binding: z.string().regex(/^[0-9a-f]{64}$/),
  profile: z.enum(["process", "terminal"]),
  expiresAt: z.number().int().positive().safe(),
});

export type E2BProcessReference = z.infer<typeof ProcessReference>;

export type E2BProcessOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "closed" | "pipe";
  format?: "text" | "bytes";
  capture?: { maxBytes: number };
  terminal?: { columns: number; rows: number };
  binding?: string;
  reopen?: E2BProcessReference;
};
