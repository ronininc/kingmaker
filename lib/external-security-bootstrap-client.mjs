import { createHash, createPublicKey, verify } from "node:crypto";
import { externalSecurityManifestSha256 } from "./external-review-adapter.mjs";

const ORIGIN = "https://www.ronininc.org",
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
const sha = (v) => createHash("sha256").update(v).digest("hex");
const keyFp = (jwk) =>
  sha(canonical({ crv: jwk?.crv, kty: jwk?.kty, x: jwk?.x }));
const publicJwk = (jwk) =>
  jwk?.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string" &&
  !jwk.d && Buffer.from(jwk.x, "base64url").length === 32;

export function createExternalSecurityBootstrapClient(
  {
    bearer,
    executorRegistrationId,
    executorFingerprint,
    evidenceSigningFingerprint,
    authorities,
    authorityStatus,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = {},
) {
  if (
    typeof bearer !== "string" || bearer.length < 16 ||
    typeof executorRegistrationId !== "string" ||
    executorRegistrationId.length < 3 ||
    !SHA.test(String(executorFingerprint)) ||
    !SHA.test(String(evidenceSigningFingerprint)) || !authorities ||
    typeof authorities !== "object" || typeof authorityStatus !== "function" ||
    typeof fetchImpl !== "function"
  ) throw new Error("EXTERNAL_BOOTSTRAP_CONFIG");
  return async (attemptId) => {
    if (!UUID.test(String(attemptId))) {
      throw new Error("EXTERNAL_BOOTSTRAP_ATTEMPT");
    }
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), TIMEOUT);
    timer.unref?.();
    try {
      const res = await fetchImpl(
        `${ORIGIN}/api/external-security/attempts/${attemptId}/bootstrap`,
        {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "application/json",
          },
        },
      );
      if (!res.ok) throw new Error(`EXTERNAL_BOOTSTRAP_HTTP_${res.status}`);
      const declared = Number(res.headers?.get?.("content-length") || 0);
      if (declared > MAX) throw new Error("EXTERNAL_BOOTSTRAP_TOO_LARGE");
      const reader = res.body?.getReader();
      let n = 0, chunks = [];
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          n += value.byteLength;
          if (n > MAX) {
            controller.abort();
            throw new Error("EXTERNAL_BOOTSTRAP_TOO_LARGE");
          }
          chunks.push(Buffer.from(value));
        }
      } else {
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length > MAX) throw new Error("EXTERNAL_BOOTSTRAP_TOO_LARGE");
        chunks = [b];
      }
      let b;
      try {
        b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("EXTERNAL_BOOTSTRAP_JSON");
      }
      const r = b?.dispatchReceipt,
        s = b?.dispatchSignature,
        a = b?.authority,
        x = b?.executor,
        m = b?.manifest,
        nowSec = Math.floor(now() / 1000);
      if (
        b?.schema !== "ronin.external-security-attempt-bootstrap/v1" ||
        b.attemptId !== attemptId || !UUID.test(String(b.jobId)) ||
        !UUID.test(String(b.boardJobId)) ||
        !UUID.test(String(b.nativeOpportunityId)) ||
        !/^[-A-Za-z0-9._:]{1,128}$/.test(String(b.sourceRootId)) ||
        !UUID.test(String(b.rootAttemptId)) ||
        b.previousAttemptId !== null &&
          !UUID.test(String(b.previousAttemptId)) ||
        !Number.isSafeInteger(b.generation) || b.generation < 1 ||
        b.generation === 1 &&
          (b.previousAttemptId !== null || b.rootAttemptId !== attemptId) ||
        b.generation > 1 &&
          (b.previousAttemptId === null || b.previousAttemptId === attemptId) ||
        typeof b.leaseToken !== "string" || !b.leaseToken ||
        !Number.isSafeInteger(b.leaseExpiresAt) || b.leaseExpiresAt <= nowSec
      ) throw new Error("EXTERNAL_BOOTSTRAP_BINDING");
      if (
        !r || r.schema !== "ronin.external-security-dispatch/v1" || !s || !a ||
        !x || !m || r.attemptId !== attemptId || r.jobId !== b.jobId ||
        r.boardJobId !== b.boardJobId || r.sourceRootId !== b.sourceRootId ||
        m.sourceRootId !== b.sourceRootId ||
        r.nativeOpportunityId !== b.nativeOpportunityId ||
        r.rootAttemptId !== b.rootAttemptId ||
        (r.previousAttemptId ?? null) !== b.previousAttemptId ||
        r.generation !== b.generation ||
        r.leaseExpiresAt !== b.leaseExpiresAt ||
        sha(b.leaseToken) !== r.leaseTokenHash ||
        externalSecurityManifestSha256(m) !== r.manifestDigest ||
        m.rulesSnapshotDigest !== r.rulesSnapshotDigest ||
        m.commitSha !== r.sourceCommit
      ) throw new Error("EXTERNAL_BOOTSTRAP_BINDING");
      if (
        x.registrationId !== executorRegistrationId ||
        x.receiverFingerprint !== executorFingerprint ||
        x.evidenceSigningFingerprint !== evidenceSigningFingerprint ||
        r.executorRegistrationId !== executorRegistrationId ||
        r.executorFingerprint !== executorFingerprint ||
        r.executorEvidenceSigningFingerprint !== evidenceSigningFingerprint ||
        !publicJwk(x.evidencePublicJwk) ||
        keyFp(x.evidencePublicJwk) !== evidenceSigningFingerprint
      ) throw new Error("EXTERNAL_BOOTSTRAP_EXECUTOR");
      const configured = authorities[s?.keyId],
        current = s?.keyId ? await authorityStatus(s.keyId) : null;
      if (
        !s?.keyId || !s.value || !publicJwk(configured?.publicJwk) ||
        !publicJwk(a.publicJwk) ||
        canonical(configured.publicJwk) !== canonical(a.publicJwk) ||
        keyFp(configured.publicJwk) !== a.fingerprint ||
        current?.active !== true || current.revoked === true ||
        current.expiresAt !== a.expiresAt ||
        r.authorityExpiresAt !== a.expiresAt || a.expiresAt <= nowSec ||
        !Number.isSafeInteger(r.issuedAt) || r.issuedAt > nowSec + 30 ||
        r.issuedAt < nowSec - 900 || !Number.isSafeInteger(r.leaseExpiresAt) ||
        r.leaseExpiresAt - r.issuedAt > 900 || r.leaseExpiresAt <= r.issuedAt ||
        !/^[A-Za-z0-9_-]{24,160}$/.test(String(r.nonce || "")) ||
        !verify(
          null,
          Buffer.from(canonical(r)),
          createPublicKey({ key: configured.publicJwk, format: "jwk" }),
          Buffer.from(s.value, "base64url"),
        )
      ) throw new Error("EXTERNAL_BOOTSTRAP_AUTHORITY");
      return structuredClone(b);
    } finally {
      clearTimeout(timer);
    }
  };
}
