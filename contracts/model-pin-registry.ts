// Ronin / Solomon — Model Pin Registry Schema v1
// Pinned model versions for Kingmaker. A model is only loadable if it has an
// active pin. Pins are content-addressed by SHA256 — no silent weight swaps.
// Unpinning requires the same authority that pinned it.

export interface ModelPinV1 {
  /** Stable identifier, e.g. "qwen3-27b-abliterated" */
  modelId: string;
  /** SHA256 of the pinned weight files (the abliterated output) */
  pinnedSha256: string;
  /** SHA256 of the official base weights this was abliterated from */
  baseModelSha256: string;
  /** Upstream source of the base weights, e.g. "Qwen/Qwen3-27B" */
  baseModelSource: string;
  /** ISO timestamp of when the pin was created */
  pinnedAt: string;
  /** Who authorized the pin (founder tap reference) */
  pinnedBy: string;
  /** Tap/audit reference that authorized this pin */
  tapReference: string;
  /** Which engagement justified the abliteration */
  engagementJustification: string;
  /** Hardware the abliteration ran on */
  hardwareDesignation: string;
  /** heretic-llm version used, for reproducibility */
  toolVersion: string;
  /** Active pins are loadable. Superseded pins are history. */
  status: 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
  /** If superseded, the modelId+sha of the replacement pin */
  supersededBy?: string;
}

export interface ModelPinRegistryV1 {
  pins: ModelPinV1[];
  /** modelId -> currently active pin. Only one ACTIVE pin per modelId. */
  activePins: Record<string, ModelPinV1>;
}

export function createEmptyPinRegistry(): ModelPinRegistryV1 {
  return { pins: [], activePins: {} };
}

/**
 * Resolve the loadable weights for a modelId. Returns null when no active
 * pin exists — Kingmaker must refuse to load unpinned weights.
 */
export function resolvePinnedModel(
  registry: ModelPinRegistryV1,
  modelId: string,
): ModelPinV1 | null {
  const pin = registry.activePins[modelId];
  if (!pin || pin.status !== 'ACTIVE') return null;
  return pin;
}

/**
 * Pin a new abliterated model version. Supersedes any existing active pin
 * for the same modelId. Pinning requires founder authority (enforced by the
 * caller — this function only maintains registry invariants).
 */
export function pinModelVersion(
  registry: ModelPinRegistryV1,
  pin: Omit<ModelPinV1, 'status'>,
): ModelPinRegistryV1 {
  const existing = registry.activePins[pin.modelId];
  const pins = registry.pins.map((p) =>
    p.modelId === pin.modelId && p.status === 'ACTIVE'
      ? { ...p, status: 'SUPERSEDED' as const, supersededBy: pin.pinnedSha256 }
      : p,
  );
  const newPin: ModelPinV1 = { ...pin, status: 'ACTIVE' };
  pins.push(newPin);
  return {
    pins,
    activePins: { ...registry.activePins, [pin.modelId]: newPin },
  };
}

/**
 * Revoke a pin. Revoked models are unloadable. Revocation is permanent —
 * re-pinning requires a fresh pin with a new tap.
 */
export function revokeModelPin(
  registry: ModelPinRegistryV1,
  modelId: string,
): ModelPinRegistryV1 {
  const existing = registry.activePins[modelId];
  if (!existing) return registry;
  const pins = registry.pins.map((p) =>
    p.modelId === modelId && p.status === 'ACTIVE'
      ? { ...p, status: 'REVOKED' as const }
      : p,
  );
  const activePins = { ...registry.activePins };
  delete activePins[modelId];
  // Mark the superseding chain explicitly — void return keeps the registry honest
  void existing;
  return { pins, activePins };
}
