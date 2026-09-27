import { expect, test } from "bun:test";
import { ProviderReadError, type ProviderDriver } from "@sandbar/provider-spi";
import { z } from "zod";
import type { ConnectionRow, ControlStore } from "@sandbar/store";
import { bundledMigration, migrate, openSqliteBackend } from "@sandbar/store";
import {
  ProviderIdentityMismatchError,
  ProviderRegistry,
  storedScope,
  type ProviderRegistration,
} from "./registry";
import { SecretBox } from "./crypto";
import { DurableRunner } from "./runner";

test("registry releases an owned transport on scope mismatch and keeps borrowed transports untouched", async () => {
  const scope = {
    provider: "modal",
    connectionId: "conn_1",
    resourceScope: { kind: "app" as const, id: "app-1" },
    region: "prod",
    endpoint: "https://api.modal.com",
  };

  let releases = 0;
  // SAFETY: The registry fixture only checks the driver's name; no driver method is invoked.
  const driver = { name: "modal" } as ProviderDriver;

  const registration: ProviderRegistration = {
    provider: "modal",
    validate: (input) => input,
    async connect() {
      return {
        driver,
        scope,
        ownership: "owned" as const,
        release: async () => {
          releases++;
        },
      };
    },
  };

  // SAFETY: The registry only calls open in this test; the prototype preserves SecretBox identity.
  const secrets = Object.assign(Object.create(SecretBox.prototype), {
    open: async () => JSON.stringify({ credentials: {}, configuration: {} }),
  }) as SecretBox;

  // SAFETY: This registry test calls connect directly and never accesses the store.
  const registry = new ProviderRegistry({} as ControlStore, secrets, [registration]);

  // SAFETY: connect reads only these ConnectionRow fields in this focused test.
  const row = {
    id: "conn_1",
    provider: "modal",
    encrypted_credentials: "cipher",
    scope: storedScope(scope),
  } as ConnectionRow;

  const lease = await registry.connect(row);
  expect(releases).toBe(0);

  if (lease.ownership === "owned") await lease.release();
  expect(releases).toBe(1);
  await expect(
    registry.connect({
      ...row,
      scope: storedScope({
        ...scope,
        resourceScope: { kind: "app", id: "app-other" },
      }),
    }),
  ).rejects.toBeInstanceOf(ProviderIdentityMismatchError);
  expect(releases).toBe(2);
});

test("definitive connection failures before submission finish without effect; observation stays uncertain", async () => {
  for (const failure of [
    "unauthenticated",
    "scope",
    "configuration",
    "response",
    "transient",
  ] as const) {
    const backend = openSqliteBackend(":memory:");
    await migrate(backend, bundledMigration("sqlite"));
    const store = new (await import("@sandbar/store")).ControlStore(backend);

    try {
      const project = await store.createProject(`Connection ${failure}`);

      const scope = {
        provider: "fake",
        connectionId: `conn_${failure}`,
        accountId: "verified-account",
        region: "local",
      };

      await store.createConnection({
        id: scope.connectionId,
        projectId: project.id,
        provider: "fake",
        name: "Verified",
        encryptedCredentials: "cipher",
      });
      await store.verifyConnection(project.id, scope.connectionId, storedScope(scope));

      // SAFETY: Only the read-only connection check uses this secret fixture.
      const secrets = Object.assign(Object.create(SecretBox.prototype), {
        open: async () => JSON.stringify({ credentials: {}, configuration: {} }),
      }) as SecretBox;

      let submissions = 0;

      let releases = 0;

      let connectFailure: typeof failure | null = failure;

      const unsupported = async () => {
        throw new Error("unexpected provider call");
      };

      const driver: ProviderDriver = {
        name: "fake",
        capabilities: unsupported,
        prepare: async () => ({
          supported: true,
          effectiveImage: "fake-starter",
        }),
        create: async (input) => {
          submissions++;

          return {
            status: "unknown",
            effect: "possible",
            submissionId: input.identity.submissionId,
            reason: "observation required",
          };
        },
        inspect: unsupported,
        inventory: unsupported,
        exec: unsupported,
        readFile: unsupported,
        writeFile: unsupported,
        destroy: unsupported,
        observe: unsupported,
      };

      const registration: ProviderRegistration = {
        provider: "fake",
        validate: (input) => {
          if (connectFailure === "configuration")
            throw new z.ZodError([
              { code: "custom", path: ["configuration"], message: "private configuration" },
            ]);

          return input;
        },
        async connect() {
          if (connectFailure === "unauthenticated")
            throw new ProviderReadError("UNAUTHENTICATED", "secret credential detail");

          if (connectFailure === "transient") throw new Error("temporary network error");

          if (connectFailure === "response")
            throw new z.ZodError([{ code: "custom", path: [], message: "private response" }]);

          return {
            driver,
            scope: connectFailure === "scope" ? { ...scope, accountId: "other-account" } : scope,
            ownership: "owned",
            release: async () => {
              releases++;
            },
          };
        },
      };

      const registry = new ProviderRegistry(store, secrets, [registration]);

      const runner = new DurableRunner({ store, registry, secrets });

      const key = Bun.randomUUIDv7();

      const admitted = await store.admitCreate({
        projectId: project.id,
        endpoint: "POST /sandboxes",
        key,
        intentHash: `create-${failure}`,
        request: { environment: { kind: "prepared", imageId: "fake-starter" } },
        connectionId: scope.connectionId,
      });

      await runner.tick();

      const afterFailure = (await store.getOperation(project.id, admitted.operation.id))!;
      expect(submissions).toBe(0);
      expect(afterFailure.submission_possible).toBe(0);

      if (failure === "transient" || failure === "response") {
        expect(afterFailure.status).toBe("queued");
        connectFailure = null;
        await Bun.sleep(5_100);
        await runner.tick();
        expect(submissions).toBe(1);
        expect((await store.getOperation(project.id, admitted.operation.id))?.status).toBe(
          "unknown",
        );
        expect(releases).toBe(1);
      } else {
        expect(afterFailure.status).toBe("failed");
        expect(afterFailure.effect).toBe("none");
        expect(JSON.stringify(afterFailure.error_json)).not.toContain("secret credential detail");

        const repeated = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key,
          intentHash: `create-${failure}`,
          request: {
            environment: { kind: "prepared", imageId: "fake-starter" },
          },
          connectionId: scope.connectionId,
        });

        expect(repeated.repeated).toBe(true);
        expect(repeated.operation.id).toBe(admitted.operation.id);
        expect(repeated.operation.status).toBe("failed");
        expect(releases).toBe(failure === "scope" ? 1 : 0);
      }

      if (failure !== "transient" && failure !== "response") {
        const possible = await store.admitCreate({
          projectId: project.id,
          endpoint: "POST /sandboxes",
          key: Bun.randomUUIDv7(),
          intentHash: `possible-${failure}`,
          request: {
            environment: { kind: "prepared", imageId: "fake-starter" },
          },
          connectionId: scope.connectionId,
        });

        const claim = (await store.claimDue("prior-submission", 1_000, project.id))!;
        expect(claim.operation.id).toBe(possible.operation.id);
        await store.beginSubmission(claim);
        await store.reschedule(claim, "outcome_unknown", 0);
        await runner.tick();

        const uncertain = (await store.getOperation(project.id, possible.operation.id))!;
        expect(uncertain.status).toBe("unknown");
        expect(uncertain.effect).toBe("possible");
        expect(uncertain.submission_possible).toBe(1);
        expect(submissions).toBe(0);
      }
    } finally {
      await store.close();
    }
  }
}, 25_000);

test("runner releases an owned provider lease after an unknown mutation without replay", async () => {
  const backend = openSqliteBackend(":memory:");
  await migrate(backend, bundledMigration("sqlite"));
  const store = new (await import("@sandbar/store")).ControlStore(backend);

  try {
    const project = await store.createProject("Lease test");

    const scope = {
      provider: "fake",
      connectionId: "conn_owned",
      accountId: "fake-local",
      region: "local",
    };

    await store.createConnection({
      id: "conn_owned",
      projectId: project.id,
      provider: "fake",
      name: "Owned",
      encryptedCredentials: "cipher",
    });
    await store.verifyConnection(project.id, "conn_owned", storedScope(scope));

    // SAFETY: This fixture only needs open; the real store and runner exercise all other boundaries.
    const secrets = Object.assign(Object.create(SecretBox.prototype), {
      open: async () => JSON.stringify({ credentials: {}, configuration: {} }),
    }) as SecretBox;

    let submissions = 0,
      releases = 0;

    const unsupported = async () => {
      throw new Error("unexpected call");
    };

    const driver: ProviderDriver = {
      name: "fake",
      capabilities: unsupported,
      prepare: async () => ({
        supported: true,
        effectiveImage: "fake-starter",
      }),
      create: async (input) => {
        submissions++;

        return {
          status: "unknown",
          effect: "possible",
          submissionId: input.identity.submissionId,
          reason: "lost",
        };
      },
      inspect: unsupported,
      inventory: unsupported,
      exec: unsupported,
      readFile: unsupported,
      writeFile: unsupported,
      destroy: unsupported,
      observe: async () => null,
    };

    const registration: ProviderRegistration = {
      provider: "fake",
      validate: (input) => input,
      async connect() {
        return {
          driver,
          scope,
          ownership: "owned",
          release: async () => {
            releases++;
          },
        };
      },
    };

    const registry = new ProviderRegistry(store, secrets, [registration]);

    const admitted = await store.admitCreate({
      projectId: project.id,
      endpoint: "POST /sandboxes",
      key: Bun.randomUUIDv7(),
      intentHash: "owned",
      request: { environment: { kind: "prepared", imageId: "fake-starter" } },
      connectionId: "conn_owned",
    });

    await new DurableRunner({ store, registry, secrets }).tick();
    expect((await store.getOperation(project.id, admitted.operation.id))?.status).toBe("unknown");
    expect(submissions).toBe(1);
    expect(releases).toBe(1);
  } finally {
    await store.close();
  }
});
