import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import {
  CreateSandboxRequest,
  ExecRequest,
  SandboxListQuery,
  type Operation,
  type Sandbox,
} from "@sandbar/contracts";
import { api, ApiError, setCsrfToken, type Connection, type Project } from "./api";
import {
  AppShell,
  Button,
  EmptyState,
  Field,
  LoadingRows,
  Notice,
  PageHead,
  StatusBadge,
} from "./components";
import {
  clearPendingInvocation,
  fileIntent,
  invocationStatus,
  recoverInvocation,
  withInvocation,
} from "./invocations";

const ErrorMessage = z
  .instanceof(Error)
  .transform((error) => error.message)
  .catch("An unexpected error occurred.");

function capturedBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function capturedText(base64?: string): string {
  if (base64 === undefined) return "(empty)";

  return new TextDecoder("utf-8").decode(capturedBytes(base64)) || "(empty)";
}

function downloadCapturedBytes(base64: string, name: string) {
  const bytes = capturedBytes(base64);

  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function useResource<T>(load: () => Promise<T>, dependency: string) {
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: string;
    loading: boolean;
    fetching: boolean;
    settled: number;
  }>({ key: dependency, loading: true, fetching: true, settled: 0 });

  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((current) =>
      current.key === dependency
        ? {
            key: dependency,
            data: current.data,
            loading: current.data === undefined,
            fetching: true,
            settled: current.settled,
          }
        : { key: dependency, loading: true, fetching: true, settled: 0 },
    );
    load()
      .then((value) => {
        if (alive)
          setState((current) => ({
            key: dependency,
            data: value,
            loading: false,
            fetching: false,
            settled: current.key === dependency ? current.settled + 1 : 1,
          }));
      })
      .catch((reason) => {
        if (alive)
          setState((current) => ({
            key: dependency,
            data: current.key === dependency ? current.data : undefined,
            error: ErrorMessage.parse(reason),
            loading: false,
            fetching: false,
            settled: current.key === dependency ? current.settled + 1 : 1,
          }));
      });

    return () => {
      alive = false;
    };
  }, [dependency, revision]);

  const current =
    state.key === dependency
      ? state
      : { key: dependency, loading: true, fetching: true, settled: 0 };

  return { ...current, refresh: () => setRevision((n) => n + 1) };
}

function AuthGate() {
  const [state, setState] = useState<"loading" | "authenticated" | "anonymous" | "error">(
    "loading",
  );

  const [mode, setMode] = useState<"login" | "setup">("login");
  const [secret, setSecret] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sessionError, setSessionError] = useState<string>();
  const [authRevision, setAuthRevision] = useState(0);
  useEffect(() => {
    let alive = true;

    const expired = () => {
      setCsrfToken(undefined);
      setOneTimeToken(undefined);
      setState("anonymous");
    };

    window.addEventListener("sandbar:session-expired", expired);
    api
      .session()
      .then((session) => {
        if (alive) {
          setCsrfToken(session.csrfToken);
          setState("authenticated");
        }
      })
      .catch((reason) => {
        if (!alive) return;

        if (reason instanceof ApiError && reason.status === 401) setState("anonymous");
        else {
          setSessionError(ErrorMessage.parse(reason));
          setState("error");
        }
      });

    return () => {
      alive = false;
      window.removeEventListener("sandbar:session-expired", expired);
    };
  }, [authRevision]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      if (mode === "setup") {
        const result = await api.setup(secret);
        setOneTimeToken(result.token);
        setCsrfToken(result.csrfToken);
      } else {
        const result = await api.login(secret);
        setCsrfToken(result.csrfToken);
      }

      setSecret("");
      setState("authenticated");
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading")
    return (
      <div className="auth-wrap">
        <LoadingRows />
      </div>
    );

  if (state === "error")
    return (
      <div className="auth-wrap">
        <div className="surface auth-panel">
          <h1>Cannot reach Sandbar</h1>
          <Notice tone="error">{sessionError}</Notice>
          <Button
            onClick={() => {
              setState("loading");
              setAuthRevision((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );

  if (state === "authenticated")
    return (
      <>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {oneTimeToken && (
          <div className="one-time-token" role="status">
            <strong>Save your API token now.</strong> It is shown once.{" "}
            <code className="mono">{oneTimeToken}</code>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setOneTimeToken(undefined)}
            >
              I saved it
            </button>
          </div>
        )}
        <Outlet />
      </>
    );

  return (
    <div className="auth-wrap">
      <div className="surface auth-panel">
        <div className="brand" style={{ color: "inherit", padding: 0, marginBottom: 26 }}>
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          Sandbar
        </div>
        <h1>{mode === "setup" ? "Set up Sandbar" : "Sign in"}</h1>
        <p>
          {mode === "setup"
            ? "Enter the single-use setup secret from the Sandbar host. The first operator account and browser session will be created."
            : "Enter your Sandbar operator token. It is exchanged for a secure browser session and is not saved in this browser."}
        </p>
        <form onSubmit={submit} className="form-stack">
          <Field label={mode === "setup" ? "Setup secret" : "Operator token"} htmlFor="auth-secret">
            <input
              className="input"
              id="auth-secret"
              type="password"
              required
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <Button variant="primary" type="submit" busy={busy}>
            {mode === "setup" ? "Create operator" : "Sign in"}
          </Button>
        </form>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "setup" : "login");
            setError(undefined);
            setSecret("");
          }}
        >
          {mode === "login" ? "First time? Set up an operator" : "Already set up? Sign in"}
        </button>
      </div>
    </div>
  );
}

function ProjectsPage() {
  const projects = useResource(api.projects, "projects");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const navigate = useNavigate();

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      const project = await api.createProject(name.trim());
      await navigate({
        to: "/projects/$projectId/connections",
        params: { projectId: project.id },
      });
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content project-picker" id="main-content" tabIndex={-1}>
      <PageHead
        title="Projects"
        subtitle="Choose a project to manage its connections and sandboxes."
      />
      {projects.loading ? (
        <LoadingRows />
      ) : projects.error ? (
        <Notice tone="error">
          {projects.error}{" "}
          <button className="text-button" onClick={projects.refresh}>
            Try again
          </button>
        </Notice>
      ) : projects.data?.items.length ? (
        <div className="surface table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>ID</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {projects.data.items.map((project: Project) => (
                <tr key={project.id}>
                  <td>
                    <strong>{project.name}</strong>
                  </td>
                  <td className="mono">{project.id}</td>
                  <td>
                    <Link
                      to="/projects/$projectId/sandboxes"
                      params={{ projectId: project.id }}
                      search={fleetSearch}
                    >
                      Open project
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No projects yet">
          Create a project to keep connections and sandboxes within one authorization boundary.
        </EmptyState>
      )}
      <section className="surface panel" style={{ maxWidth: 520, marginTop: 24 }}>
        <h2 className="section-title">Create a project</h2>
        <form className="form-stack" onSubmit={create}>
          <Field label="Project name" htmlFor="project-name">
            <input
              className="input"
              id="project-name"
              required
              minLength={1}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <div>
            <Button variant="primary" type="submit" busy={busy}>
              Create project
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}

function ProjectLayout() {
  const { projectId } = projectRoute.useParams();
  const projects = useResource(api.projects, "project-context");
  const project = projects.data?.items.find((item) => item.id === projectId);

  if (projects.loading)
    return (
      <main className="content" id="main-content" tabIndex={-1}>
        <LoadingRows />
      </main>
    );

  if (projects.error)
    return (
      <main className="content" id="main-content" tabIndex={-1}>
        <Notice tone="error">
          {projects.error} <Button onClick={projects.refresh}>Retry projects</Button>
        </Notice>
      </main>
    );

  if (!project)
    return (
      <main className="content" id="main-content" tabIndex={-1}>
        <Notice tone="error">This project is unavailable or you do not have access.</Notice>
        <Link to="/projects">Choose another project</Link>
      </main>
    );

  return (
    <AppShell projectId={projectId} projectName={project.name}>
      <Outlet />
    </AppShell>
  );
}

function ConnectionsPage() {
  const { projectId } = projectRoute.useParams();
  const connections = useResource(() => api.connections(projectId), projectId);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"fake" | "daytona">("fake");
  const [apiKey, setApiKey] = useState("");
  const [target, setTarget] = useState("us");
  const [apiUrl, setApiUrl] = useState("https://app.daytona.io/api");
  const [toolboxOrigin, setToolboxOrigin] = useState("https://proxy.app.daytona.io");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);

    try {
      await api.createConnection(
        projectId,
        provider === "fake"
          ? { provider, name: name.trim() }
          : {
              provider,
              name: name.trim(),
              credentials: { apiKey },
              configuration: { apiUrl, toolboxOrigin, target, ttlMinutes: "60" },
            },
      );
      setName("");
      setApiKey("");
      setNotice("Connection added. Verify its native scope before creating a sandbox.");
      connections.refresh();
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  async function verify(id: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);

    try {
      await api.verifyConnection(projectId, id);
      setNotice("Connection scope verified.");
      connections.refresh();
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead
        title="Provider connections"
        subtitle="Credentials are encrypted by the service. Verification reads native identity before this connection can create sandboxes."
      />
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <section className="surface panel" style={{ marginTop: 18 }}>
        <h2 className="section-title">Add provider connection</h2>
        <form className="toolbar" onSubmit={create}>
          <Field label="Provider" htmlFor="connection-provider">
            <select
              className="select"
              id="connection-provider"
              value={provider}
              onChange={(e) => setProvider(z.enum(["fake", "daytona"]).parse(e.target.value))}
            >
              <option value="fake">Fake test provider</option>
              <option value="daytona">Daytona</option>
            </select>
          </Field>
          <Field label="Connection name" htmlFor="connection-name">
            <input
              className="input"
              id="connection-name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {provider === "daytona" && (
            <>
              <Field label="Daytona API key" htmlFor="connection-api-key">
                <input
                  className="input"
                  id="connection-api-key"
                  type="password"
                  autoComplete="off"
                  required
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </Field>
              <Field label="Daytona target" htmlFor="connection-target">
                <input
                  className="input"
                  id="connection-target"
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </Field>
              <Field label="Daytona API URL" htmlFor="connection-api-url">
                <input
                  className="input"
                  id="connection-api-url"
                  type="url"
                  required
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Field>
              <Field label="Daytona toolbox origin" htmlFor="connection-toolbox-origin">
                <input
                  className="input"
                  id="connection-toolbox-origin"
                  type="url"
                  required
                  value={toolboxOrigin}
                  onChange={(e) => setToolboxOrigin(e.target.value)}
                />
              </Field>
            </>
          )}
          <Button variant="primary" busy={busy} type="submit">
            Add connection
          </Button>
        </form>
      </section>
      <section style={{ marginTop: 24 }}>
        <h2 className="section-title">Connections</h2>
        {connections.error && connections.data && (
          <Notice tone="error">
            {connections.error} <Button onClick={connections.refresh}>Retry connections</Button>
          </Notice>
        )}
        {connections.loading ? (
          <LoadingRows />
        ) : !connections.data ? (
          <Notice tone="error">
            {connections.error ?? "Connections unavailable"}{" "}
            <Button onClick={connections.refresh}>Retry connections</Button>
          </Notice>
        ) : connections.data?.items.length ? (
          <div className="surface table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Native scope</th>
                  <th>Capabilities</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {connections.data.items.map((connection: Connection) => (
                  <tr key={connection.id}>
                    <td>
                      <strong>{connection.name}</strong>
                      <div className="mono">{connection.id}</div>
                    </td>
                    <td>{connection.provider}</td>
                    <td>
                      <StatusBadge status={connection.status} />
                    </td>
                    <td>{connection.nativeScope?.accountId ?? "Not verified"}</td>
                    <td>
                      {connection.capabilities
                        ? Object.entries(connection.capabilities)
                            .filter(([, enabled]) => enabled)
                            .map(([name]) => name)
                            .join(", ")
                        : "Not verified"}
                    </td>
                    <td>
                      <Button
                        onClick={() => verify(connection.id)}
                        busy={busy}
                        disabled={connection.status === "verified"}
                      >
                        Verify scope
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No connections">
            Add a provider connection to make sandbox creation available.
          </EmptyState>
        )}
      </section>
    </>
  );
}

const fleetSearch = { state: "", connectionId: "", q: "", cursor: "" };

function FleetPage() {
  const { projectId } = projectRoute.useParams();
  const search = fleetRoute.useSearch();
  const navigate = useNavigate();

  const sandboxes = useResource(
    () => api.sandboxes(projectId, search),
    `${projectId}:${JSON.stringify(search)}`,
  );

  const connections = useResource(() => api.connections(projectId), projectId);
  const [connectionId, setConnectionId] = useState("");
  const [preparedImageId, setPreparedImageId] = useState("");
  const [labelKey, setLabelKey] = useState("");
  const [labelValue, setLabelValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [, refreshInvocations] = useState(0);
  const createScope = `create:${projectId}`;
  const createStatus = invocationStatus(createScope);

  const available = connections.data?.items.filter((c) => c.status === "verified") ?? [];

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      const selected = available.find((item) => item.id === connectionId) ?? available[0];

      const candidate: CreateSandboxRequest = {
        environment: {
          kind: "prepared" as const,
          imageId: selected?.provider === "fake" ? "fake-starter" : preparedImageId.trim(),
        },
        network: { policy: "blocked" as const },
        connectionId: selected?.id,
      };

      if (labelKey.trim()) candidate.labels = { [labelKey.trim()]: labelValue.trim() };

      const input = CreateSandboxRequest.parse(candidate);

      const accepted = await withInvocation(createScope, input, (key) =>
        api.createSandbox(projectId, input, key),
      );

      await navigate({
        to: "/projects/$projectId/operations/$operationId",
        params: { projectId, operationId: accepted.operation.id },
      });
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  async function findCreate() {
    setBusy(true);
    setError(undefined);

    try {
      const accepted = await recoverInvocation(createScope, (key) =>
        api.invocation(projectId, key, "create"),
      );

      if (!accepted) return;
      await navigate({
        to: "/projects/$projectId/operations/$operationId",
        params: { projectId, operationId: accepted.id },
      });
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  function updateSearch(patch: Partial<typeof fleetSearch>) {
    void navigate({
      to: fleetRoute.fullPath,
      params: { projectId },
      search: { ...search, ...patch, cursor: "" },
      replace: true,
    });
  }

  return (
    <>
      <PageHead
        title="Fleet"
        subtitle="The listed state is Sandbar's latest observation. Check freshness before acting on a sandbox."
        action={<Button onClick={sandboxes.refresh}>Refresh fleet</Button>}
      />
      <section className="surface panel">
        <h2 className="section-title">Create a sandbox</h2>
        {connections.loading ? (
          <LoadingRows count={1} />
        ) : connections.error ? (
          <Notice tone="error">
            Could not load provider connections: {connections.error}{" "}
            <Button onClick={connections.refresh}>Retry connections</Button>
          </Notice>
        ) : !available.length ? (
          <Notice tone="warning">
            Verify a provider connection before creating a sandbox.{" "}
            <Link to="/projects/$projectId/connections" params={{ projectId }}>
              Manage connections
            </Link>
          </Notice>
        ) : (
          <form className="toolbar" onSubmit={create}>
            <div className="field">
              <span className="field-label">Blocked network</span>
              <span className="field-hint">
                Daytona requires an existing active snapshot ID. OCI builds are not enabled in this
                slice.
              </span>
            </div>
            <Field label="Connection" htmlFor="create-connection">
              <select
                className="select"
                id="create-connection"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                <option value="">Project default</option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            {(available.find((item) => item.id === connectionId) ?? available[0])?.provider !==
              "fake" && (
              <Field label="Prepared image ID" htmlFor="create-prepared-image">
                <input
                  className="input"
                  id="create-prepared-image"
                  required
                  value={preparedImageId}
                  onChange={(e) => setPreparedImageId(e.target.value)}
                />
              </Field>
            )}
            <Field label="Label key (optional)" htmlFor="create-label-key">
              <input
                className="input"
                id="create-label-key"
                maxLength={64}
                value={labelKey}
                onChange={(e) => setLabelKey(e.target.value)}
              />
            </Field>
            <Field label="Label value" htmlFor="create-label-value">
              <input
                className="input"
                id="create-label-value"
                maxLength={256}
                value={labelValue}
                onChange={(e) => setLabelValue(e.target.value)}
                disabled={!labelKey.trim()}
              />
            </Field>
            <Button variant="primary" type="submit" busy={busy}>
              Create sandbox
            </Button>
          </form>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {!busy && createStatus && (
          <div className="actions" style={{ marginTop: 12 }}>
            <span className="field-hint">
              {createStatus === "pending"
                ? "Retry the same inputs to recover this request."
                : "The previous create was accepted. Same inputs reopen its operation."}
            </span>
            <Button onClick={findCreate}>Find accepted operation</Button>
            <Button
              onClick={async () => {
                if (
                  window.confirm(
                    createStatus === "pending"
                      ? "A prior request may have taken effect. Starting a new attempt can duplicate it. Continue?"
                      : "The previous request was accepted. Starting a new attempt can create another effect. Continue?",
                  )
                ) {
                  try {
                    await clearPendingInvocation(createScope);
                    setError(undefined);
                    refreshInvocations((revision) => revision + 1);
                  } catch (reason) {
                    setError(ErrorMessage.parse(reason));
                  }
                }
              }}
            >
              Start new create attempt
            </Button>
          </div>
        )}
      </section>
      <section style={{ marginTop: 28 }}>
        <div className="page-head">
          <h2 className="section-title">Sandboxes</h2>
        </div>
        <div className="toolbar">
          <Field label="Search" htmlFor="fleet-search">
            <input
              className="input"
              id="fleet-search"
              type="search"
              maxLength={64}
              value={search.q}
              onChange={(e) => updateSearch({ q: e.target.value })}
              placeholder="Search labels or ID"
            />
          </Field>
          <Field label="State" htmlFor="fleet-state">
            <select
              className="select"
              id="fleet-state"
              value={search.state}
              onChange={(e) => updateSearch({ state: e.target.value })}
            >
              <option value="">All states</option>
              {["resolving", "provisioning", "running", "destroying", "destroyed", "unknown"].map(
                (s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="Connection" htmlFor="fleet-connection">
            <select
              className="select"
              id="fleet-connection"
              value={search.connectionId}
              onChange={(e) => updateSearch({ connectionId: e.target.value })}
            >
              <option value="">All connections</option>
              {connections.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {sandboxes.error && sandboxes.data && (
          <Notice tone="error">
            {sandboxes.error}{" "}
            <button className="text-button" onClick={sandboxes.refresh}>
              Try again
            </button>
          </Notice>
        )}
        {sandboxes.loading ? (
          <LoadingRows />
        ) : !sandboxes.data ? (
          <Notice tone="error">
            {sandboxes.error ?? "Fleet unavailable"}{" "}
            <button className="text-button" onClick={sandboxes.refresh}>
              Try again
            </button>
          </Notice>
        ) : sandboxes.data?.items.length ? (
          <>
            <div className="surface table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Sandbox</th>
                    <th>Observed</th>
                    <th>Desired</th>
                    <th>Connection</th>
                    <th>Freshness</th>
                    <th>Labels</th>
                  </tr>
                </thead>
                <tbody>
                  {sandboxes.data.items.map((box: Sandbox) => (
                    <tr key={box.id}>
                      <td>
                        <Link
                          to="/projects/$projectId/sandboxes/$sandboxId"
                          params={{ projectId, sandboxId: box.id }}
                        >
                          {box.id}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge status={box.observedState} />
                      </td>
                      <td>{box.desiredState}</td>
                      <td className="mono">{box.connectionId}</td>
                      <td>
                        {box.observedAt ? (
                          <time dateTime={box.observedAt}>
                            {new Date(box.observedAt).toLocaleString()}
                          </time>
                        ) : (
                          "No observation yet"
                        )}
                      </td>
                      <td>
                        {Object.entries(box.labels)
                          .map(([key, value]) => `${key}: ${value}`)
                          .join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sandboxes.data.nextCursor && (
              <div style={{ marginTop: 16 }}>
                <Button
                  onClick={() =>
                    void navigate({
                      to: fleetRoute.fullPath,
                      params: { projectId },
                      search: {
                        ...search,
                        cursor: sandboxes.data!.nextCursor ?? "",
                      },
                    })
                  }
                >
                  Next page
                </Button>
              </div>
            )}
          </>
        ) : (
          <EmptyState title="No sandboxes match">
            Create one above or clear the filters to see the fleet.
          </EmptyState>
        )}
      </section>
    </>
  );
}

function SandboxPage() {
  const { projectId, sandboxId } = sandboxRoute.useParams();

  const box = useResource(() => api.sandbox(projectId, sandboxId), `${projectId}:${sandboxId}`);

  const navigate = useNavigate();
  const [command, setCommand] = useState("echo hello");
  const [path, setPath] = useState("/work/example.txt");
  const [file, setFile] = useState<File>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [, refreshInvocations] = useState(0);
  const execScope = `exec:${projectId}:${sandboxId}`;
  const destroyScope = `destroy:${projectId}:${sandboxId}`;
  const fileScope = `file_write:${projectId}:${sandboxId}`;

  async function run(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      const input = ExecRequest.parse({
        command: { kind: "shell" as const, script: command },
        output: { capture: "bounded" as const, maxBytes: 65536 },
      });

      const accepted = await withInvocation(execScope, input, (key) =>
        api.execute(projectId, sandboxId, input, key),
      );

      await navigate({
        to: "/projects/$projectId/operations/$operationId",
        params: { projectId, operationId: accepted.operation.id },
      });
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (
      !window.confirm("Destroy this sandbox's compute? This submits a durable cleanup operation.")
    )
      return;
    setBusy(true);
    setError(undefined);

    try {
      const accepted = await withInvocation(destroyScope, { projectId, sandboxId }, (key) =>
        api.destroySandbox(projectId, sandboxId, key),
      );

      await navigate({
        to: "/projects/$projectId/operations/$operationId",
        params: { projectId, operationId: accepted.operation.id },
      });
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();

    if (!file) return;

    if (file.size > 1_048_576) {
      setError("Choose a file of 1 MiB or less.");

      return;
    }

    setBusy(true);
    setError(undefined);
    setNotice(undefined);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const intent = await fileIntent(path, bytes);

      const result = await withInvocation(fileScope, intent, (key) =>
        api.writeFile(projectId, sandboxId, path, bytes, key),
      );

      if (fileInput.current) fileInput.current.value = "";
      setFile(undefined);

      if ("operation" in result)
        await navigate({
          to: "/projects/$projectId/operations/$operationId",
          params: { projectId, operationId: result.operation.id },
        });
      else setNotice(`Wrote ${result.bytesWritten} bytes to ${result.path}.`);
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    setError(undefined);

    try {
      const blob = await api.readFile(projectId, sandboxId, path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = path.split("/").pop() || "download";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  async function findAction(scope: string, kind: "exec" | "destroy" | "file_write") {
    setBusy(true);
    setError(undefined);

    try {
      const accepted = await recoverInvocation(scope, (key) =>
        api.invocation(projectId, key, kind, sandboxId),
      );

      if (!accepted) return;
      await navigate({
        to: "/projects/$projectId/operations/$operationId",
        params: { projectId, operationId: accepted.id },
      });
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  if (box.loading) return <LoadingRows />;

  if (!box.data)
    return (
      <Notice tone="error">
        {box.error ?? "Sandbox unavailable"} <Button onClick={box.refresh}>Retry sandbox</Button>
      </Notice>
    );
  const sandbox = box.data;
  const isRunning = sandbox.observedState === "running";

  return (
    <>
      <PageHead
        title={`Sandbox ${sandbox.id}`}
        subtitle="Actions use durable operations. Closing this browser does not cancel an operation or destroy the sandbox."
        action={
          <div className="actions">
            <Button onClick={box.refresh}>Refresh state</Button>
            <Button
              variant="danger"
              onClick={destroy}
              busy={busy}
              disabled={sandbox.desiredState === "destroyed"}
            >
              Destroy sandbox
            </Button>
          </div>
        }
      />
      {box.error && <Notice tone="error">{box.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!busy &&
        (
          [
            { scope: execScope, kind: "exec" as const },
            { scope: destroyScope, kind: "destroy" as const },
            { scope: fileScope, kind: "file_write" as const },
          ] as const
        ).flatMap(({ scope, kind }) =>
          invocationStatus(scope)
            ? [
                <div className="actions" key={scope} style={{ marginTop: 12 }}>
                  <span className="field-hint">
                    {invocationStatus(scope) === "pending"
                      ? `${kind}: retry the same inputs or find the accepted operation.`
                      : `${kind}: the previous request was accepted. Same inputs reopen its operation.`}
                  </span>
                  <Button onClick={() => void findAction(scope, kind)}>
                    Find accepted operation
                  </Button>
                  <Button
                    onClick={async () => {
                      if (
                        window.confirm(
                          invocationStatus(scope) === "pending"
                            ? "A prior request may have taken effect. Starting a new attempt can duplicate it. Continue?"
                            : "The previous request was accepted. Starting a new attempt can create another effect. Continue?",
                        )
                      ) {
                        try {
                          await clearPendingInvocation(scope);
                          setError(undefined);
                          refreshInvocations((revision) => revision + 1);
                        } catch (reason) {
                          setError(ErrorMessage.parse(reason));
                        }
                      }
                    }}
                  >
                    Start new {kind} attempt
                  </Button>
                </div>,
              ]
            : [],
        )}
      {notice && <Notice>{notice}</Notice>}
      {sandbox.observedState === "unknown" && (
        <Notice tone="warning">
          The provider outcome is uncertain. Check the related operation before requesting another
          effect.
        </Notice>
      )}
      {sandbox.currentOperationId && (
        <Notice>
          Current operation:{" "}
          <Link
            to="/projects/$projectId/operations/$operationId"
            params={{ projectId, operationId: sandbox.currentOperationId }}
          >
            {sandbox.currentOperationId}
          </Link>
        </Notice>
      )}
      <div className="detail-grid" style={{ marginTop: 18 }}>
        <div className="stack">
          <section className="surface panel">
            <h2 className="section-title">State and provenance</h2>
            <dl className="facts">
              <dt>Observed state</dt>
              <dd>
                <StatusBadge status={sandbox.observedState} />
              </dd>
              <dt>Desired state</dt>
              <dd>{sandbox.desiredState}</dd>
              <dt>Observed</dt>
              <dd>
                {sandbox.observedAt ? (
                  <time dateTime={sandbox.observedAt}>
                    {new Date(sandbox.observedAt).toLocaleString()}
                  </time>
                ) : (
                  "No observation yet"
                )}
              </dd>
              <dt>Revision</dt>
              <dd>{sandbox.revision}</dd>
              <dt>Connection</dt>
              <dd className="mono">{sandbox.connectionId}</dd>
              <dt>Environment</dt>
              <dd className="mono">
                {sandbox.environment.kind === "oci"
                  ? sandbox.environment.reference
                  : sandbox.environment.imageId}
              </dd>
              <dt>Network policy</dt>
              <dd>{sandbox.network.policy}</dd>
            </dl>
          </section>
          <section className="surface panel">
            <h2 className="section-title">Run a command</h2>
            <form className="form-stack" onSubmit={run}>
              <Field
                label="Shell script"
                hint="The fake provider returns only configured fixture results. Output is captured up to 64 KiB."
                htmlFor="command"
              >
                <textarea
                  className="textarea mono"
                  id="command"
                  required
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </Field>
              <div>
                <Button variant="primary" type="submit" busy={busy} disabled={!isRunning}>
                  Run command
                </Button>
              </div>
            </form>
            {!isRunning && (
              <p className="field-hint">
                Execution is available when the sandbox is observed running.
              </p>
            )}
          </section>
          <section className="surface panel">
            <h2 className="section-title">Files</h2>
            <form className="form-stack" onSubmit={upload}>
              <Field label="Remote path" htmlFor="file-path">
                <input
                  className="input mono"
                  id="file-path"
                  required
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </Field>
              <Field label="Local file" hint="Maximum 1 MiB." htmlFor="file-upload">
                <input
                  id="file-upload"
                  type="file"
                  ref={fileInput}
                  onChange={(e) => setFile(e.target.files?.[0])}
                />
              </Field>
              <div className="actions">
                <Button variant="primary" type="submit" busy={busy} disabled={!isRunning || !file}>
                  Upload file
                </Button>
                <Button type="button" onClick={download} busy={busy} disabled={!isRunning}>
                  Download path
                </Button>
              </div>
            </form>
          </section>
        </div>
        <aside className="stack">
          <section className="surface panel">
            <h2 className="section-title">Labels</h2>
            {Object.keys(sandbox.labels).length ? (
              <dl className="facts">
                {Object.entries(sandbox.labels).map(([key, value]) => (
                  <FragmentPair key={key} label={key} value={value} />
                ))}
              </dl>
            ) : (
              <p className="field-hint">No labels were assigned.</p>
            )}
          </section>
          <Notice>
            State can become stale while provider work continues. Use Refresh state to read the
            latest Sandbar observation.
          </Notice>
        </aside>
      </div>
    </>
  );
}

function FragmentPair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function OperationPage() {
  const { projectId, operationId } = operationRoute.useParams();

  const operation = useResource(
    () => api.operation(projectId, operationId),
    `${projectId}:${operationId}`,
  );

  const executionKey = `${projectId}:${operationId}:${operation.data?.executionId ?? ""}`;

  const [executionState, setExecutionState] = useState<{
    key: string;
    data?: Awaited<ReturnType<typeof api.execution>>;
    error?: string;
  }>({ key: executionKey });

  const execution = executionState.key === executionKey ? executionState.data : undefined;

  const executionError = executionState.key === executionKey ? executionState.error : undefined;

  const [executionRevision, setExecutionRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (
      !operation.data ||
      operation.fetching ||
      ["succeeded", "failed"].includes(operation.data.status)
    )
      return;
    const timer = window.setTimeout(operation.refresh, 1200);

    return () => window.clearTimeout(timer);
  }, [operation.data?.status, operation.fetching, operation.settled]);
  useEffect(() => {
    let alive = true;
    const executionId = operation.data?.executionId;
    setExecutionState({ key: executionKey });

    if (executionId)
      api.execution(projectId, executionId).then(
        (data) => {
          if (alive) setExecutionState({ key: executionKey, data });
        },
        (reason) => {
          if (alive) setExecutionState({ key: executionKey, error: ErrorMessage.parse(reason) });
        },
      );

    return () => {
      alive = false;
    };
  }, [executionKey, operation.data?.updatedAt, executionRevision]);

  async function reconcile() {
    setBusy(true);
    setError(undefined);

    try {
      await api.reconcile(projectId, operationId);
      operation.refresh();
    } catch (reason) {
      setError(ErrorMessage.parse(reason));
    } finally {
      setBusy(false);
    }
  }

  if (operation.loading && !operation.data) return <LoadingRows />;

  if (!operation.data)
    return (
      <Notice tone="error">
        {operation.error ?? "Operation unavailable"}{" "}
        <Button onClick={operation.refresh}>Retry operation</Button>
      </Notice>
    );
  const op: Operation = operation.data;

  return (
    <>
      <PageHead
        title={`Operation ${op.id}`}
        subtitle="This page observes a durable operation. Reloading it does not start another provider action."
        action={<Button onClick={operation.refresh}>Refresh operation</Button>}
      />
      {operation.error && <Notice tone="error">{operation.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {executionError && (
        <Notice tone="error">
          {executionError}{" "}
          <Button onClick={() => setExecutionRevision((revision) => revision + 1)}>
            Retry execution details
          </Button>
        </Notice>
      )}
      {op.status === "unknown" && (
        <Notice tone="warning">
          The provider may already have applied this action. Check again observes and reconciles; it
          does not resubmit the action.
        </Notice>
      )}
      <div className="detail-grid">
        <section className="surface panel">
          <h2 className="section-title">Progress</h2>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={op.status} />
            </dd>
            <dt>Kind</dt>
            <dd>{op.kind}</dd>
            <dt>Phase</dt>
            <dd>{op.phase}</dd>
            <dt>Possible effect</dt>
            <dd>{op.effect}</dd>
            <dt>Updated</dt>
            <dd>{new Date(op.updatedAt).toLocaleString()}</dd>
            <dt>Sandbox</dt>
            <dd>
              {op.sandboxId ? (
                <Link
                  to="/projects/$projectId/sandboxes/$sandboxId"
                  params={{ projectId, sandboxId: op.sandboxId }}
                >
                  {op.sandboxId}
                </Link>
              ) : (
                "Pending"
              )}
            </dd>
          </dl>
          {op.error && (
            <Notice tone="error">
              {op.error.message} ({op.error.code}). Retry guidance:{" "}
              {op.error.retry.replaceAll("_", " ")}.
            </Notice>
          )}
          <div className="actions" style={{ marginTop: 20 }}>
            <Button onClick={reconcile} busy={busy} disabled={!op.recovery.includes("check_again")}>
              Check again
            </Button>
          </div>
          {!op.recovery.includes("check_again") && op.status === "unknown" && (
            <p className="field-hint">No observe-only recovery action is currently available.</p>
          )}
        </section>
        <section className="surface panel">
          <h2 className="section-title">Evidence</h2>
          <p className="field-hint">
            Operation ID and timestamps remain available even if command output expires.
          </p>
          <dl className="facts">
            <dt>Created</dt>
            <dd>{new Date(op.createdAt).toLocaleString()}</dd>
            <dt>Execution</dt>
            <dd className="mono">{op.executionId ?? "—"}</dd>
          </dl>
        </section>
      </div>
      {op.kind === "exec" && (
        <section className="surface panel" style={{ marginTop: 20 }}>
          <h2 className="section-title">Command result</h2>
          {execution ? (
            <>
              <dl className="facts">
                <dt>Exit code</dt>
                <dd>{execution.exitCode ?? "Pending"}</dd>
                <dt>Output</dt>
                <dd>
                  <StatusBadge status={execution.outputAvailability} /> {execution.capturedBytes}{" "}
                  bytes captured
                </dd>
              </dl>
              {execution.outputAvailability === "not_captured" ? (
                <p>Output was not captured.</p>
              ) : execution.outputAvailability === "expired" ? (
                <p>Output expired under the retention policy. Exit status remains available.</p>
              ) : execution.outputAvailability === "evicted" ? (
                <p>
                  Output was evicted before its retention period ended. Exit status remains
                  available.
                </p>
              ) : (
                <>
                  <p className="field-hint">
                    Text is shown as UTF-8. Download the captured bytes for exact output.
                  </p>
                  <h3 className="section-title">Stdout</h3>
                  <pre className="output">{capturedText(execution.stdoutBase64)}</pre>
                  {execution.stdoutBase64 !== undefined && (
                    <Button
                      onClick={() =>
                        downloadCapturedBytes(execution.stdoutBase64!, `${op.id}-stdout.bin`)
                      }
                    >
                      Download stdout bytes
                    </Button>
                  )}
                  <h3 className="section-title">Stderr</h3>
                  <pre className="output">{capturedText(execution.stderrBase64)}</pre>
                  {execution.stderrBase64 !== undefined && (
                    <Button
                      onClick={() =>
                        downloadCapturedBytes(execution.stderrBase64!, `${op.id}-stderr.bin`)
                      }
                    >
                      Download stderr bytes
                    </Button>
                  )}
                  {execution.outputAvailability === "truncated" && (
                    <Notice tone="warning">
                      Output was truncated at the configured capture limit.
                    </Notice>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="field-hint">Execution details are loading or not yet available.</p>
          )}
        </section>
      )}
    </>
  );
}

const rootRoute = createRootRoute({ component: AuthGate });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <Navigate to="/projects" />,
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: ProjectLayout,
});

const connectionsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/connections",
  component: ConnectionsPage,
});

const fleetRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/sandboxes",
  validateSearch: (search) => ({
    state: SandboxListQuery.shape.state.catch(undefined).parse(search.state) ?? "",
    connectionId:
      SandboxListQuery.shape.connectionId.catch(undefined).parse(search.connectionId) ?? "",
    q: SandboxListQuery.shape.q.catch(undefined).parse(search.q) ?? "",
    cursor: SandboxListQuery.shape.cursor.catch(undefined).parse(search.cursor) ?? "",
  }),
  component: FleetPage,
});

const sandboxRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/sandboxes/$sandboxId",
  component: SandboxPage,
});

const operationRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/operations/$operationId",
  component: OperationPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  projectRoute.addChildren([connectionsRoute, fleetRoute, sandboxRoute, operationRoute]),
]);

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: () => (
    <main className="content" id="main-content" tabIndex={-1}>
      <EmptyState title="Page not found">
        The route may have changed. <Link to="/projects">Choose a project</Link>.
      </EmptyState>
    </main>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
