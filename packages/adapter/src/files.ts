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

/** An immediate directory enumeration observed on a changing filesystem. */
export type DirectoryResult = {
  entries: FileEntry[];
  completeness: "complete" | "unknown";
  observedAt: string;
};

/** Omitted metadata is unavailable, never a fabricated default. */
export type FileStat = {
  type: FileEntry["type"];
  sizeBytes?: number;
  modifiedAt?: string;
  mode?: number;
};

export type FileTransferInput = {
  sandbox: import("./index").Sandbox;
  source: string;
  destination: string;
  overwrite: boolean;
};

/** Report only correlated implementation artifacts; never caller-owned files. */
export type FileTransferContext = import("./index").ReadContext & {
  retain?: (details: { temporaryPaths?: string[]; bytesTransferred?: number }) => void;
};
