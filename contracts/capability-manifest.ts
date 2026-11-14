// Ronin / Solomon — Capability Manifest Schema v1
// Every capability must describe where it can run, what authority it requires, what it depends on,
// how it fails, and how it can be repaired.

import type {
  KingmakerRiskClass,
  RoninDeviceTier,
  RoninProductClass,
  RoninRuntimeWeight,
  RoninWorkloadType,
  RuntimeRepairRecommendation,
} from './runtime-sovereignty';

export type CapabilityAuthorityLevel =
  | 'NONE'
  | 'USER'
  | 'OPERATOR'
  | 'MANAGER'
  | 'ADMIN'
  | 'FOUNDER';

export type CapabilityLifecycleState =
  | 'DRAFT'
  | 'EXPERIMENTAL'
  | 'INTERNAL_ONLY'
  | 'CUSTOMER_AVAILABLE'
  | 'CANON'
  | 'DEPRECATED'
  | 'RETIRED';

export type CapabilityFailureImpact = 'NO_IMPACT' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'CRITICAL';

export type CapabilityRepairMode =
  | 'NONE'
  | 'SELF_REPAIR'
  | 'CODAGEN_LOCAL'
  | 'KINGMAKER_REVIEW'
  | 'FOUNDER_REVIEW'
  | 'HARDWARE_OPERATOR_REQUIRED';

export interface CapabilityIoField {
  key: string;
  label: string;
  typePlain: string;
  required: boolean;
  sensitive: boolean;
  descriptionPlain: string;
}

export interface CapabilityDependency {
  id: string;
  label: string;
  required: boolean;
  minimumVersion?: string;
  missingBehavior: 'BLOCK' | 'DEGRADE' | 'ADVISORY_ONLY';
  reasonPlain: string;
}

export interface CapabilityFailureMode {
  id: string;
  label: string;
  impact: CapabilityFailureImpact;
  causePlain: string;
  detectionPlain: string;
  userVisibleMessagePlain: string;
  recommendedRepair: RuntimeRepairRecommendation;
}

export interface CapabilityManifestV1 {
  schemaVersion: '1.0';
  capabilityId: string;
  displayName: string;
  descriptionPlain: string;
  productClass: RoninProductClass;
  lifecycleState: CapabilityLifecycleState;
  riskClass: KingmakerRiskClass;
  workloadType: RoninWorkloadType;
  runtimeWeight: RoninRuntimeWeight;
  minimumDeviceTier: RoninDeviceTier;
  preferredDeviceTier: RoninDeviceTier;
  authorityRequired: CapabilityAuthorityLevel;
  requiresHumanApproval: boolean;
  mayRunOffline: boolean;
  mayUseExternalConnectors: boolean;
  mayTouchCustomerData: boolean;
  mayTouchRoninIp: boolean;
  mayTouchPhysicalHardware: boolean;
  inputs: CapabilityIoField[];
  outputs: CapabilityIoField[];
  dependencies: CapabilityDependency[];
  failureModes: CapabilityFailureMode[];
  repairMode: CapabilityRepairMode;
  auditRequired: boolean;
  attributionRequired: boolean;
  ownerPlain: string;
  notesPlain?: string;
}

export function isCapabilityPhoneSafe(manifest: CapabilityManifestV1): boolean {
  return manifest.runtimeWeight === 'PHONE_SAFE' && manifest.minimumDeviceTier === 'PHONE_RUNTIME';
}

export function requiresFounderAuthority(manifest: CapabilityManifestV1): boolean {
  return manifest.authorityRequired === 'FOUNDER' || manifest.riskClass === 'RED';
}

export function requiresMachineRuntime(manifest: CapabilityManifestV1): boolean {
  return manifest.workloadType === 'FABRICATION' || manifest.mayTouchPhysicalHardware;
}

export function requiresLocalCodegen(manifest: CapabilityManifestV1): boolean {
  return manifest.workloadType === 'CODAGEN' || manifest.repairMode === 'CODAGEN_LOCAL';
}

export const CODAGEN_LOCAL_MANIFEST: CapabilityManifestV1 = {
  schemaVersion: '1.0',
  capabilityId: 'ronin.codagen.local',
  displayName: 'CodaGen Local',
  descriptionPlain: 'Local-first code generation, repair, and validation workload for repositories on average desktop runtime.',
  productClass: 'KINGMAKER_CLASS',
  lifecycleState: 'INTERNAL_ONLY',
  riskClass: 'YELLOW',
  workloadType: 'CODAGEN',
  runtimeWeight: 'DESKTOP_SAFE',
  minimumDeviceTier: 'AVERAGE_DESKTOP_RUNTIME',
  preferredDeviceTier: 'AVERAGE_DESKTOP_RUNTIME',
  authorityRequired: 'ADMIN',
  requiresHumanApproval: true,
  mayRunOffline: true,
  mayUseExternalConnectors: false,
  mayTouchCustomerData: false,
  mayTouchRoninIp: true,
  mayTouchPhysicalHardware: false,
  inputs: [
    {
      key: 'repositoryPath',
      label: 'Repository Path',
      typePlain: 'local filesystem path',
      required: true,
      sensitive: true,
      descriptionPlain: 'Local repository path where CodaGen may inspect, repair, test, and stage changes.',
    },
  ],
  outputs: [
    {
      key: 'buildReport',
      label: 'Build Report',
      typePlain: 'governed repair/build report',
      required: true,
      sensitive: false,
      descriptionPlain: 'Summary of changes, tests, failures, repairs, and governance deltas.',
    },
  ],
  dependencies: [
    {
      id: 'local.git',
      label: 'Local Git Repository',
      required: true,
      missingBehavior: 'BLOCK',
      reasonPlain: 'CodaGen must operate on an inspectable local repository with version control.',
    },
  ],
  failureModes: [
    {
      id: 'codagen.governance-delta',
      label: 'Governance Delta Detected',
      impact: 'MAJOR',
      causePlain: 'Requested repair would alter governance, authority, audit, or constitutional behavior.',
      detectionPlain: 'Manifest or diff analysis detects governance-impacting changes.',
      userVisibleMessagePlain: 'Repair blocked. Requested change affects governance and requires founder review.',
      recommendedRepair: 'FOUNDER_REVIEW_REQUIRED',
    },
  ],
  repairMode: 'CODAGEN_LOCAL',
  auditRequired: true,
  attributionRequired: false,
  ownerPlain: 'Ronin Inc. / Kingmaker',
  notesPlain: 'CodaGen is local-first. Server acceleration is optional and must not become the default identity.',
};

export const FABRICATION_HOST_MANIFEST: CapabilityManifestV1 = {
  schemaVersion: '1.0',
  capabilityId: 'solomon.fabrication.host',
  displayName: 'Fabrication Host',
  descriptionPlain: 'Dedicated machine or host runtime for physical fabrication control, machine telemetry, and governed hardware execution.',
  productClass: 'SOLOMON_CLASS',
  lifecycleState: 'CUSTOMER_AVAILABLE',
  riskClass: 'YELLOW',
  workloadType: 'FABRICATION',
  runtimeWeight: 'SERVER_RECOMMENDED',
  minimumDeviceTier: 'OPTIONAL_SERVER_RUNTIME',
  preferredDeviceTier: 'OPTIONAL_SERVER_RUNTIME',
  authorityRequired: 'OPERATOR',
  requiresHumanApproval: true,
  mayRunOffline: true,
  mayUseExternalConnectors: true,
  mayTouchCustomerData: false,
  mayTouchRoninIp: false,
  mayTouchPhysicalHardware: true,
  inputs: [
    {
      key: 'jobPlan',
      label: 'Fabrication Job Plan',
      typePlain: 'governed fabrication job plan',
      required: true,
      sensitive: false,
      descriptionPlain: 'Validated fabrication instructions, machine target, material assumptions, and safety status.',
    },
  ],
  outputs: [
    {
      key: 'fabricationTelemetry',
      label: 'Fabrication Telemetry',
      typePlain: 'machine telemetry and execution status',
      required: true,
      sensitive: false,
      descriptionPlain: 'Machine state, job progress, failure events, operator acknowledgments, and audit events.',
    },
  ],
  dependencies: [
    {
      id: 'machine.host',
      label: 'Dedicated Machine Host',
      required: true,
      missingBehavior: 'ADVISORY_ONLY',
      reasonPlain: 'Physical fabrication requires a machine-attached host runtime. Without one, Solomon may advise but may not execute.',
    },
  ],
  failureModes: [
    {
      id: 'fabrication.host-missing',
      label: 'Fabrication Host Missing',
      impact: 'MODERATE',
      causePlain: 'No dedicated fabrication host or machine runtime is available.',
      detectionPlain: 'Device router cannot locate a machine-capable runtime.',
      userVisibleMessagePlain: 'Fabrication host unavailable. Solomon can provide advisory output only.',
      recommendedRepair: 'UPGRADE_OR_INSTALL_REQUIRED',
    },
  ],
  repairMode: 'HARDWARE_OPERATOR_REQUIRED',
  auditRequired: true,
  attributionRequired: false,
  ownerPlain: 'Ronin Inc. / Solomon',
  notesPlain: 'Fabrication is delegated to dedicated machine host/server runtime because physical execution requires hardware supervision.',
};
