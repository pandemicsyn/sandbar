/** Shared resource validation and error helpers for the separately packaged service client. */
export {
  awaitSubmission,
  checkExec,
  execOutput,
  newInvocationKey,
  raceAbort,
  rethrowCloseWithReference,
  sealedReference,
  throwIfAborted,
  validateCreate,
  validateExec,
  validateFilePath,
  validateReference,
  waitDelay,
} from "./resource";
