export class AdapterError extends Error {
  constructor(
    readonly code: import("./index").AdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Filesystem effects retained when a transfer or publish cannot be confirmed. */
export class AdapterFilesystemError extends AdapterError {
  constructor(
    code: import("./index").AdapterErrorCode,
    message: string,
    readonly details: {
      effect: import("./portable").SafeError["effect"];
      source?: string;
      destination?: string;
      temporaryPaths?: string[];
      bytesTransferred?: number;
    },
  ) {
    super(code, message);
    this.name = "AdapterFilesystemError";
  }
}
