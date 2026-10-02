import { z } from "zod";
import { FilePath } from "./portable";

/** Complete immediate child listing; no filtering or successful prefixes. */
export type FileEntry = {
  name: string;
  type: "file" | "directory" | "symlink" | "unknown";
};

export const MAX_DIRECTORY_ENTRIES = 1024;

export const MAX_DIRECTORY_NAME_BYTES = 65_536;

export type FileMutationInput = {
  sandbox: import("./index").Sandbox;
  path: string;
  recursive: boolean;
};

export const FileMutationIntent = z.strictObject({ path: FilePath, recursive: z.boolean() });

export const FileMutationValue = z.strictObject({ acknowledged: z.literal(true) });

export type FileMutationValue = z.infer<typeof FileMutationValue>;
