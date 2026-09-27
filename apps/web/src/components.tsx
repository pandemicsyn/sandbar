import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { api } from "./api";

export function Button({
  children,
  variant = "secondary",
  busy = false,
  ...props
}: PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "danger";
    busy?: boolean;
  }
>) {
  return (
    <button
      {...props}
      className={`button button-${variant}`}
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Notice({
  children,
  tone = "info",
  role,
}: PropsWithChildren<{
  tone?: "info" | "warning" | "error";
  role?: "alert" | "status";
}>) {
  return (
    <div className="notice" data-tone={tone} role={role ?? (tone === "error" ? "alert" : "status")}>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return (
    <div className="surface empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function LoadingRows({ count = 4 }: { count?: number }) {
  return (
    <div className="surface panel stack" role="status" aria-label="Loading data">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${82 - i * 9}%` }} />
      ))}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ["running", "succeeded", "verified", "healthy"].includes(status)
    ? "success"
    : ["unknown", "queued", "pending", "provisioning", "draining"].includes(status)
      ? "warning"
      : ["failed", "error"].includes(status)
        ? "danger"
        : undefined;

  return (
    <span className="badge" data-tone={tone}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function PageHead({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function AppShell({
  projectId,
  projectName,
  children,
}: PropsWithChildren<{ projectId: string; projectName: string }>) {
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Project navigation">
        <Link
          className="brand"
          to="/projects/$projectId/sandboxes"
          params={{ projectId }}
          search={{ state: "", connectionId: "", q: "", cursor: "" }}
        >
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          Sandbar
        </Link>
        <nav className="nav-group" aria-label="Resources">
          <span className="nav-caption">{projectName}</span>
          <Link
            className="nav-link"
            activeProps={{ "data-active": "true" }}
            to="/projects/$projectId/sandboxes"
            params={{ projectId }}
            search={{ state: "", connectionId: "", q: "", cursor: "" }}
          >
            Fleet
          </Link>
          <Link
            className="nav-link"
            activeProps={{ "data-active": "true" }}
            to="/projects/$projectId/connections"
            params={{ projectId }}
          >
            Connections
          </Link>
        </nav>
        <div className="sidebar-foot">
          Self-hosted control plane
          <br />
          Provider actions continue when this tab closes.
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="topbar-label">
            Project: <strong>{projectName}</strong>
          </span>
          <div className="actions">
            <Link className="button button-secondary" to="/projects">
              Switch project
            </Link>
            <Button
              onClick={() => {
                void api
                  .logout()
                  .then(() => window.location.assign("/"))
                  .catch((error) =>
                    window.alert(error instanceof Error ? error.message : "Sign out failed"),
                  );
              }}
            >
              Sign out
            </Button>
          </div>
        </header>
        <main className="content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
