import { z } from "zod";

/** Ephemeral HTTP access, never a sandbox reference or a readiness observation. */
export type Preview =
  | { access: "public"; url: string }
  | { access: "protected"; url: string; headers: Record<string, string> };

const PreviewUrl = z
  .url()
  .max(8192)
  .refine((value) => {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  });

export const PreviewResult = z.discriminatedUnion("access", [
  z.strictObject({ access: z.literal("public"), url: PreviewUrl }),
  z.strictObject({
    access: z.literal("protected"),
    url: PreviewUrl,
    headers: z
      .record(
        z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
        z
          .string()
          .min(1)
          .max(8192)
          .regex(/^[^\r\n]+$/),
      )
      .refine((headers) => Object.keys(headers).length > 0 && Object.keys(headers).length <= 16),
  }),
]);

export const PreviewPort = z.number().int().min(1).max(65535);
