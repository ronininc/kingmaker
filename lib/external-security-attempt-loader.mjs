import { createScriptureCommandGate } from './scripture-command-gate.mjs';
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { createExternalSecurityBootstrapClient } from "./external-security-bootstrap-client.mjs";
import { createExternalBootstrapCache } from "./external-bootstrap-cache.mjs";
import { createExternalSecurityCrmClient } from "./external-security-crm-client.mjs";
import { createExternalDispatchAdmissionStore } from "./external-dispatch-store.mjs";
import { createExternalEvidenceJournal } from "./external-evidence-journal.mjs";
import { createExternalInventoryRuntimeConfig } from "./external-security-inventory-runtime.mjs";
import {
  createExternalDispatchReceiptVerifier,
  externalSecurityManifestSha256,
} from "./external-review-adapter.mjs";

const ORIGIN = "https://www.ronininc.org",
  ACCOUNT = "attempt-runtime-v1",
  SERVICE = "com.ronininc.kingmaker.external-security",
  MAX = 256 * 1024,
  TIMEOUT = 15_000,
  SHA = /^[a-f0-9]{64}$/,
  UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonical = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : `{${
      Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) =>
        `${JSON.stringify(k)}:${canonical(x)}`
      ).join(",")
    }}`;
const fp = (j) =>
  createHash("sha256").update(canonical({ crv: j?.crv, kty: j?.kty, x: j?.x }))
    .digest("hex");
const pub = (j) =>
  j?.kty === "OKP" && j.crv === "Ed25519" && typeof j.x === "string" && !j.d &&
  Buffer.from(j.x, "base64url").length === 32;
export function isBootstrapRecoveryAllowed(error) {
  const message = String(error?.message || "");
  return /^EXTERNAL_BOOTSTRAP_HTTP_(404|409|410)$/.test(message) ||
    (error?.name === "AbortError") ||
    (error instanceof TypeError &&
      /fetch|network|socket|connection|aborted/i.test(message));
}
export async function freshStatusOrClose(status, attemptId, cache) {
  try {
    return await status(attemptId);
  } catch (error) {
    cache.close();
    throw error;
  }
}
export function readExternalSecurityAttemptRuntimeSecret(
  { platform = process.platform, exec = spawnSync, env = process.env } = {},
) {
  let bin, args, childEnv = {};
  if (platform === "darwin") {
    bin = "/usr/bin/security";
    args = ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"];
  } else if (platform === "linux") {
    bin = "/usr/bin/secret-tool";
    args = ["lookup", "service", SERVICE, "account", ACCOUNT];
    childEnv = {
      DBUS_SESSION_BUS_ADDRESS: String(env.DBUS_SESSION_BUS_ADDRESS || ""),
      DISPLAY: String(env.DISPLAY || ""),
    };
  } else return { status: -1, stdout: "" };
  const r = exec(bin, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r?.error ? -1 : r?.status, stdout: String(r?.stdout ?? "") };
}
const parseRuntime = (result) => {
  if (
    result?.status !== 0 || typeof result.stdout !== "string" ||
    Buffer.byteLength(result.stdout) > 64 * 1024
  ) throw new Error("EXTERNAL_ATTEMPT_RUNTIME_UNAVAILABLE");
  let r;
  try {
    r = JSON.parse(result.stdout);
  } catch {
    throw new Error("EXTERNAL_ATTEMPT_RUNTIME_INVALID");
  }
  if (
    r?.schema !== "ronin.external-security-local-runtime/v1" ||
    typeof r.executorBearer !== "string" || r.executorBearer.length < 16 ||
    typeof r.executorRegistrationId !== "string" ||
    !SHA.test(String(r.executorFingerprint)) ||
    !SHA.test(String(r.evidenceSigningFingerprint)) ||
    !r.evidencePrivateJwk?.d ||
    !pub({ ...r.evidencePrivateJwk, d: undefined }) ||
    fp(r.evidencePrivateJwk) !== r.evidenceSigningFingerprint ||
    Buffer.from(String(r.bootstrapCacheKey || ""), "base64url").length !== 32 ||
    !r.authorities || typeof r.authorities !== "object" ||
    !Array.isArray(r.sourceRoots) || !r.sourceRoots.length ||
    !isAbsolute(String(r.journalRoot))
  ) throw new Error("EXTERNAL_ATTEMPT_RUNTIME_INVALID");
  const seen = new Set();
  for (const x of r.sourceRoots) {
    if (
      !/^[-A-Za-z0-9._:]{1,128}$/.test(String(x?.id)) || seen.has(x.id) ||
      !/^https:\/\//.test(String(x.repositoryUrl)) ||
      !isAbsolute(String(x.path))
    ) throw new Error("EXTERNAL_ATTEMPT_RUNTIME_INVALID");
    seen.add(x.id);
  }
  for (const [id, a] of Object.entries(r.authorities)) {
    if (!id || !pub(a?.publicJwk)) {
      throw new Error("EXTERNAL_ATTEMPT_RUNTIME_INVALID");
    }
  }
  return Object.freeze(r);
};
export async function boundedExternalAttemptResponse(
  url,
  { bearer, fetchImpl, signal, method = "GET", headers = {}, body } = {},
) {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN) throw new Error("EXTERNAL_ATTEMPT_ORIGIN");
  const c = new AbortController(), timer = setTimeout(() => c.abort(), TIMEOUT);
  timer.unref?.();
  const abort = () => c.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method,
      body,
      redirect: "error",
      signal: c.signal,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json",
        ...headers,
      },
    });
    const declared = Number(res.headers?.get?.("content-length") || 0);
    if (declared > MAX) throw new Error("EXTERNAL_ATTEMPT_RESPONSE_TOO_LARGE");
    const reader = res.body?.getReader();
    let n = 0, chunks = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > MAX) throw new Error("EXTERNAL_ATTEMPT_RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(value));
      }
    } else {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX) {
        throw new Error("EXTERNAL_ATTEMPT_RESPONSE_TOO_LARGE");
      }
      chunks = [bytes];
    }
    let json = null;
    const bytes = Buffer.concat(chunks);
    if (bytes.length) {
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error("EXTERNAL_ATTEMPT_BAD_JSON");
      }
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
}
async function boundedJson(url, options) {
  const r = await boundedExternalAttemptResponse(url, options);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`EXTERNAL_ATTEMPT_HTTP_${r.status}`);
  }
  return r.json;
}
export function createExternalSecurityAttemptLoader(
  {
    mapping,
    platform = process.platform,
    readRuntime = readExternalSecurityAttemptRuntimeSecret,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = {},
) {
  if (
    !mapping?.deskSlug || !UUID.test(String(mapping.pairingId)) ||
    typeof readRuntime !== "function" || typeof fetchImpl !== "function"
  ) throw new Error("EXTERNAL_ATTEMPT_LOADER_CONFIG");
  const runtime = parseRuntime(readRuntime({ platform }));
  if (
    runtime.executorRegistrationId !== mapping.executorRegistrationId ||
    runtime.executorFingerprint !== mapping.executorFingerprint
  ) throw new Error("EXTERNAL_ATTEMPT_LOADER_IDENTITY");
  if (!runtime.commandArmor || typeof runtime.commandArmor.senderBlock !== "string" ||
      !isAbsolute(String(runtime.commandArmor.state ?? "")) ||
      runtime.commandArmor.audience !== runtime.executorRegistrationId) {
    throw new Error("SCRIPTURE_COMMAND_LOCAL_CONFIG_REQUIRED");
  }
  const status = async (attemptId) => {
    const s = await boundedJson(
      `${ORIGIN}/api/external-security/attempts/${attemptId}/status`,
      { bearer: runtime.executorBearer, fetchImpl },
    );
    if (
      s?.schema !== "ronin.external-security-attempt-status/v1" ||
      s.attemptId !== attemptId ||
      s.executorRegistrationId !== runtime.executorRegistrationId ||
      s.executorFingerprint !== runtime.executorFingerprint ||
      s.executorEvidenceSigningFingerprint !==
        runtime.evidenceSigningFingerprint ||
      s.deskSlug !== mapping.deskSlug || s.pairingId !== mapping.pairingId ||
      s.pairedDeviceActive !== true || !UUID.test(String(s.jobId)) ||
      !UUID.test(String(s.boardJobId)) ||
      !UUID.test(String(s.nativeOpportunityId)) ||
      !/^[-A-Za-z0-9._:]{1,128}$/.test(String(s.sourceRootId)) ||
      !SHA.test(String(s.manifestDigest)) ||
      !SHA.test(String(s.rulesSnapshotDigest)) ||
      !/^[a-f0-9]{40}$/.test(String(s.sourceCommit)) ||
      !Number.isSafeInteger(s.generation) || s.generation < 1 ||
      !SHA.test(String(s.leaseTokenHash)) ||
      !Number.isSafeInteger(s.leaseExpiresAt) || !s.dispatchKeyId
    ) throw new Error("EXTERNAL_ATTEMPT_STATUS_BINDING");
    return s;
  };
  return async (attemptId) => {
    await status(attemptId);
    const cache = createExternalBootstrapCache({
        path: join(runtime.journalRoot, attemptId, "bootstrap.sqlite"),
        key: Buffer.from(runtime.bootstrapCacheKey, "base64url"),
      }),
      authorities = runtime.authorities,
      authorityStatus = async (keyId) => {
        const s = await status(attemptId);
        if (
          s.dispatchKeyId !== keyId ||
          canonical(s.authorityPublicJwk) !==
            canonical(authorities[keyId]?.publicJwk)
        ) return { active: false, revoked: true, expiresAt: 0 };
        return {
          active: s.authorityActive,
          revoked: s.authorityRevokedAt != null,
          expiresAt: s.authorityExpiresAt,
        };
      },
      bootstrapClient = createExternalSecurityBootstrapClient({
        bearer: runtime.executorBearer,
        executorRegistrationId: runtime.executorRegistrationId,
        executorFingerprint: runtime.executorFingerprint,
        evidenceSigningFingerprint: runtime.evidenceSigningFingerprint,
        authorities,
        authorityStatus,
        fetchImpl,
        now,
      });
    let bootstrap;
    try {
      bootstrap = await bootstrapClient(attemptId);
      cache.put(attemptId, bootstrap);
    } catch (error) {
      if (!isBootstrapRecoveryAllowed(error)) {
        cache.close();
        throw error;
      }
      bootstrap = cache.get(attemptId);
      if (!bootstrap) {
        cache.close();
        throw error;
      }
    }
    const current = await freshStatusOrClose(status, attemptId, cache);
    const nowSec = Math.floor(now() / 1000),
      receipt = bootstrap.dispatchReceipt;
    if (
      current.jobId !== bootstrap.jobId ||
      current.boardJobId !== bootstrap.boardJobId ||
      current.sourceRootId !== bootstrap.sourceRootId ||
      current.manifestDigest !== receipt.manifestDigest ||
      current.rulesSnapshotDigest !== receipt.rulesSnapshotDigest ||
      current.sourceCommit !== receipt.sourceCommit ||
      current.rootAttemptId !== receipt.rootAttemptId ||
      (current.previousAttemptId ?? null) !==
        (receipt.previousAttemptId ?? null) ||
      current.generation !== receipt.generation ||
      current.leaseTokenHash !== receipt.leaseTokenHash ||
      current.leaseExpiresAt !== receipt.leaseExpiresAt ||
      current.leaseExpiresAt <= nowSec ||
      current.nonce !== receipt.nonce ||
      current.dispatchKeyId !== bootstrap.dispatchSignature.keyId ||
      current.executorActive !== true || current.executorRevokedAt != null ||
      current.authorityActive !== true || current.authorityRevokedAt != null ||
      current.authorityExpiresAt !== bootstrap.authority.expiresAt ||
      current.authorityExpiresAt <= nowSec
    ) {
      cache.close();
      throw new Error("EXTERNAL_ATTEMPT_BOOTSTRAP_STATUS");
    }
    const root = runtime.sourceRoots.find((x) =>
      x.id === bootstrap.sourceRootId
    );
    if (!root || root.repositoryUrl !== bootstrap.manifest.repositoryUrl) {
      cache.close();
      throw new Error("EXTERNAL_ATTEMPT_SOURCE_ROOT");
    }
    if (typeof bootstrap.commandArmorPacket !== "string" || !bootstrap.commandArmorPacket) {
      cache.close();
      throw new Error("SCRIPTURE_COMMAND_ARMOR_REQUIRED");
    }
    const key = createPrivateKey({
        key: runtime.evidencePrivateJwk,
        format: "jwk",
      }),
      evidenceSigner = {
        fingerprint: runtime.evidenceSigningFingerprint,
        sign: async (bytes) => sign(null, bytes, key).toString("base64url"),
      },
      crmClient = createExternalSecurityCrmClient({
        bearer: runtime.executorBearer,
        attemptId,
        rootAttemptId: bootstrap.rootAttemptId,
        previousAttemptId: bootstrap.previousAttemptId,
        generation: bootstrap.generation,
        evidenceSigningFingerprint: runtime.evidenceSigningFingerprint,
        evidenceSigner,
        leaseToken: bootstrap.leaseToken,
        manifestDigest: bootstrap.dispatchReceipt.manifestDigest,
        rulesSnapshotDigest: bootstrap.manifest.rulesSnapshotDigest,
        sourceCommit: bootstrap.manifest.commitSha,
        transport: (req) =>
          boundedExternalAttemptResponse(req.url, {
            bearer: runtime.executorBearer,
            fetchImpl,
            method: req.method,
            headers: req.headers,
            body: req.body,
          }),
      }),
      dir = join(runtime.journalRoot, attemptId),
      admissionStore = createExternalDispatchAdmissionStore({
        path: join(dir, "admission.sqlite"),
      }),
      evidenceJournal = createExternalEvidenceJournal({
        path: join(dir, "evidence.sqlite"),
      }),
      executor = {
        id: runtime.executorRegistrationId,
        fingerprint: runtime.executorFingerprint,
        evidenceSigningFingerprint: runtime.evidenceSigningFingerprint,
      },
      attemptStatus = async () => {
        const s = await status(attemptId);
        return {
          status: s.status,
          supersededAt: s.supersededAt,
          jobId: s.jobId,
          manifestSha256: s.manifestDigest,
          executorId: s.executorRegistrationId,
          leaseTokenHash: s.leaseTokenHash,
          leaseExpiresAt: s.leaseExpiresAt,
          nonce: s.nonce,
          dispatchKeyId: s.dispatchKeyId,
          rootAttemptId: s.rootAttemptId,
          previousAttemptId: s.previousAttemptId,
          generation: s.generation,
        };
      },
      verifyDispatchReceipt = createExternalDispatchReceiptVerifier({
        authorities,
        executorRegistration: executor,
        now,
        admissionStore,
        authorityStatus,
        executorStatus: async () => {
          const s = await status(attemptId);
          return {
            active: s.executorActive,
            revoked: s.executorRevokedAt != null,
          };
        },
        attemptStatus,
      }),
      config = createExternalInventoryRuntimeConfig({
        attemptId,
        allowedRoots: [root.path],
        evidenceJournal,
        commandGate: createScriptureCommandGate({ ...runtime.commandArmor, now }),
        armorPacket: bootstrap.commandArmorPacket,
      }),
      job = {
        schema: "ronin.external-security-local-dispatch/v1",
        externalJobId: bootstrap.jobId,
        boardJobId: bootstrap.boardJobId,
        nativeOpportunityId: bootstrap.nativeOpportunityId,
        manifest: bootstrap.manifest,
        manifestSha256: externalSecurityManifestSha256(bootstrap.manifest),
        execution: {
          mode: "local-static-source-review",
          localSourcePath: root.path,
          network: false,
          credentials: "fake-only",
          submission: "owner-approval-required",
        },
      };
    return {
      config,
      crmClient,
      verifyDispatchReceipt,
      job,
      executorRegistrationId: runtime.executorRegistrationId,
      executorFingerprint: runtime.executorFingerprint,
      completedAt: () => Math.floor(now() / 1000),
      close: () => {
        config.commandGate.close();
        cache.close();
        admissionStore.close();
        evidenceJournal.close();
      },
    };
  };
}
