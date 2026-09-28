export class AdapterError extends Error {
  constructor(
    readonly code: import("./index").AdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
