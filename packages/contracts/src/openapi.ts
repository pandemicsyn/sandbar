import { z } from "zod";
import {
  AcceptedExecution, AcceptedOperation, CreateProjectRequest, CreateProviderConnectionRequest, InvocationKey, Id,
  CreateSandboxRequest, ErrorResponse, Execution, ExecRequest, FileReceipt, Operation,
  Project, ProjectPage, ProviderConnection, ProviderConnectionPage, Sandbox, SandboxPage, SandboxListQuery, OperationResult,
  SessionRequest, SessionResponse, SetupRequest, StreamFrame,
} from "./index";

const schemas = {
  AcceptedExecution, AcceptedOperation, CreateProjectRequest, CreateProviderConnectionRequest, InvocationKey, Id,
  CreateSandboxRequest, ErrorResponse, Execution, ExecRequest, FileReceipt, Operation,
  Project, ProjectPage, ProviderConnection, ProviderConnectionPage, Sandbox, SandboxPage, SandboxListQuery, OperationResult,
  SessionRequest, SessionResponse, SetupRequest, StreamFrame,
};
const component = (name: keyof typeof schemas) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: keyof typeof schemas) => ({ content: { "application/json": { schema: component(name) } } });
const response = (description: string, name: keyof typeof schemas) => ({ description, ...json(name) });
const accepted = (name: keyof typeof schemas) => ({ "202": response("Durably accepted", name), default: response("Structured error", "ErrorResponse") });
const ordinary = (name: keyof typeof schemas) => ({ "200": response("Success", name), default: response("Structured error", "ErrorResponse") });
const projectParameter = { name: "projectId", in: "path", required: true, schema: component("Id") };
const sandboxParameter = { name: "sandboxId", in: "path", required: true, schema: component("Id") };
const operationParameter = { name: "operationId", in: "path", required: true, schema: component("Id") };
const connectionParameter = { name: "connectionId", in: "path", required: true, schema: component("Id") };
const invocationHeader = { name: "Idempotency-Key", in: "header", required: true, schema: component("InvocationKey"), description: "UUIDv7; project and endpoint scoped. Reuse only for the same caller intent." };
const sandboxListParameters = [
  { name: "cursor", in: "query", required: false, schema: { type: "string", maxLength: 256 } },
  { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
  { name: "connectionId", in: "query", required: false, schema: component("Id") },
  { name: "state", in: "query", required: false, schema: { type: "string", enum: ["resolving", "provisioning", "running", "destroying", "destroyed", "unknown"] } },
  { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 64 } },
];

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "Sandbar initial control API", version: "0.1.0", description: "Initial fake-provider vertical slice. Binary files and stream frames use separate schemas." },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/v1/setup": { post: { operationId: "setupOperator", security: [], requestBody: { required: true, ...json("SetupRequest") }, responses: ordinary("SessionResponse") } },
    "/v1/sessions": { post: { operationId: "createSession", security: [], requestBody: { required: true, ...json("SessionRequest") }, responses: ordinary("SessionResponse") } },
    "/v1/session": { get: { operationId: "getSession", responses: ordinary("SessionResponse") } },
    "/v1/projects": {
      get: { operationId: "listProjects", responses: ordinary("ProjectPage") },
      post: { operationId: "createProject", requestBody: { required: true, ...json("CreateProjectRequest") }, responses: { "201": response("Created", "Project"), default: response("Structured error", "ErrorResponse") } },
    },
    "/v1/projects/{projectId}/provider-connections": {
      parameters: [projectParameter], get: { operationId: "listProviderConnections", responses: ordinary("ProviderConnectionPage") },
      post: { operationId: "createProviderConnection", requestBody: { required: true, ...json("CreateProviderConnectionRequest") }, responses: { "201": response("Created", "ProviderConnection"), default: response("Structured error", "ErrorResponse") } },
    },
    "/v1/projects/{projectId}/provider-connections/{connectionId}/verify": { parameters: [projectParameter, connectionParameter], post: { operationId: "verifyProviderConnection", responses: ordinary("ProviderConnection") } },
    "/v1/projects/{projectId}/sandboxes": {
      parameters: [projectParameter], get: { operationId: "listSandboxes", parameters: sandboxListParameters, responses: ordinary("SandboxPage") },
      post: { operationId: "submitCreate", parameters: [invocationHeader], requestBody: { required: true, ...json("CreateSandboxRequest") }, responses: accepted("AcceptedOperation") },
    },
    "/v1/projects/{projectId}/sandboxes/{sandboxId}": {
      parameters: [projectParameter, sandboxParameter], get: { operationId: "getSandbox", responses: ordinary("Sandbox") },
      delete: { operationId: "submitDestroy", parameters: [invocationHeader], responses: accepted("AcceptedOperation") },
    },
    "/v1/projects/{projectId}/sandboxes/{sandboxId}/executions": { parameters: [projectParameter, sandboxParameter], post: { operationId: "submitExec", parameters: [invocationHeader], requestBody: { required: true, ...json("ExecRequest") }, responses: accepted("AcceptedExecution") } },
    "/v1/projects/{projectId}/sandboxes/{sandboxId}/files": {
      parameters: [projectParameter, sandboxParameter, { name: "path", in: "query", required: true, schema: { type: "string" } }],
      get: { operationId: "readFile", responses: { "200": { description: "Raw binary file", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, default: response("Structured error", "ErrorResponse") } },
      put: { operationId: "writeFile", parameters: [invocationHeader], requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, responses: { ...ordinary("FileReceipt"), "202": response("Durably accepted but transfer effect pending or unknown", "AcceptedOperation") } },
    },
    "/v1/projects/{projectId}/operations/{operationId}": { parameters: [projectParameter, operationParameter], get: { operationId: "getOperation", responses: ordinary("Operation") } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: "openapi-3.1" })])),
  },
} as const;
