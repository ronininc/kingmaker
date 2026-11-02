import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  boundedExternalAttemptResponse,
  createExternalSecurityAttemptLoader,
  freshStatusOrClose,
  isBootstrapRecoveryAllowed,
  readExternalSecurityAttemptRuntimeSecret,
} from "../lib/external-security-attempt-loader.mjs";

const pairingId = "11111111-1111-4111-8111-111111111111";
const mapping = {
  deskSlug: "desk-fixture",
  pairingId,
  executorRegistrationId: "executor-fixture",
  executorFingerprint: "e".repeat(64),
};

test("attempt runtime is disabled on platforms without an approved secret-store adapter", () => {
  let called = false;
  assert.deepEqual(
    readExternalSecurityAttemptRuntimeSecret({
      platform: "win32",
      exec: () => {
        called = true;
      },
    }),
    { status: -1, stdout: "" },
  );
  assert.equal(called, false);
});

test("attempt loader rejects missing, plaintext-like, or identity-mismatched governed runtime data", () => {
  assert.throws(
    () =>
      createExternalSecurityAttemptLoader({
        mapping,
        readRuntime: () => ({ status: -1, stdout: "" }),
        fetchImpl: async () => {
          throw new Error("network must not run");
        },
      }),
    /RUNTIME_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      createExternalSecurityAttemptLoader({
        mapping,
        readRuntime: () => ({ status: 0, stdout: "not-json" }),
        fetchImpl: async () => {
          throw new Error("network must not run");
        },
      }),
    /RUNTIME_INVALID/,
  );
  const { privateKey } = generateKeyPairSync("ed25519"),
    jwk = privateKey.export({ format: "jwk" }),
    runtime = {
      schema: "ronin.external-security-local-runtime/v1",
      executorBearer: "fixture-bearer-not-real",
      executorRegistrationId: "wrong",
      executorFingerprint: "e".repeat(64),
      evidenceSigningFingerprint: "f".repeat(64),
      evidencePrivateJwk: jwk,
      authorities: {},
      sourceRoots: [{
        id: "a",
        repositoryUrl: "https://example.invalid/repo",
        path: "/private/repo",
      }],
      journalRoot: "/private/journal",
    };
  assert.throws(
    () =>
      createExternalSecurityAttemptLoader({
        mapping,
        readRuntime: () => ({ status: 0, stdout: JSON.stringify(runtime) }),
        fetchImpl: async () => {
          throw new Error("network must not run");
        },
      }),
    /RUNTIME_INVALID|LOADER_IDENTITY/,
  );
});

test("bootstrap recovery is a strict transport/consumed-status allowlist", () => {
  for (const code of [404, 409, 410]) {
    assert.equal(
      isBootstrapRecoveryAllowed(new Error(`EXTERNAL_BOOTSTRAP_HTTP_${code}`)),
      true,
    );
  }
  assert.equal(
    isBootstrapRecoveryAllowed(new TypeError("fetch failed: connection reset")),
    true,
  );
  assert.equal(
    isBootstrapRecoveryAllowed(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ),
    true,
  );
  for (
    const message of [
      "EXTERNAL_BOOTSTRAP_HTTP_401",
      "EXTERNAL_BOOTSTRAP_AUTHORITY",
      "EXTERNAL_BOOTSTRAP_EXECUTOR",
      "EXTERNAL_BOOTSTRAP_BINDING",
      "EXTERNAL_BOOTSTRAP_JSON",
      "EXTERNAL_ATTEMPT_STATUS_BINDING",
    ]
  ) assert.equal(isBootstrapRecoveryAllowed(new Error(message)), false);
  assert.equal(
    isBootstrapRecoveryAllowed(new TypeError("semantic failure")),
    false,
  );
});

test("non-stream CRM responses enforce the same 256 KiB body limit", async () => {
  const response = {
    status: 200,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new Uint8Array(256 * 1024 + 1).buffer,
  };
  await assert.rejects(
    () =>
      boundedExternalAttemptResponse(
        "https://www.ronininc.org/api/external-security/fixture",
        { bearer: "fixture-bearer-not-real", fetchImpl: async () => response },
      ),
    /RESPONSE_TOO_LARGE/,
  );
});

test("failed post-cache status validation closes the cache handle", async () => {
  let closed = 0;
  await assert.rejects(
    () =>
      freshStatusOrClose(
        async () => {
          throw new Error("EXTERNAL_ATTEMPT_STATUS_BINDING");
        },
        "attempt",
        { close: () => closed++ },
      ),
    /STATUS_BINDING/,
  );
  assert.equal(closed, 1);
});
