// Ronin / Solomon — Runtime Sovereignty Contracts
// Canonical boundary contracts for Constitution, Kingmaker, Vault, Solomon, Orb, Daemon, and device-tier runtimes.

export type RoninRuntimeLayer =
  | 'CONSTITUTION'
  | 'KINGMAKER'
  | 'VAULT'
  | 'SOLOMON_RUNTIME'
  | 'ORB_RUNTIME'
  | 'DAEMON_RUNTIME'
  | 'CUSTOMER_NODE';

export type RoninProductClass = 'KINGMAKER_CLASS' | 'SOLOMON_CLASS' | 'HYBRID_INCUBATION';

export type RoninAuthorityState =
  | 'FOUNDER_PRESENT'
  | 'FOUNDER_ABSENT'
  | 'KINGMAKER_ACTING_ADMIN'
  | 'FOUNDER_ACTIVE_ADMIN_THROUGH_KINGMAKER';

export type KingmakerRiskClass = 'GREEN' | 'YELLOW' | 'RED';

export type RoninDeviceTier = 'PHONE_RUNTIME' | 'AVERAGE_DESKTOP_RUNTIME' | 'OPTIONAL_SERVER_RUNTIME';

export type RoninExecutionMode = 'RUN_LOCAL' | 'QUEUE_FOR_SYNC' | 'DELEGATE_TO_DESKTOP' | 'DELEGATE_TO_SERVER' | 'ADVISORY_ONLY' | 'BLOCKED';

export type RoninRuntimeWeight = 'PHONE_SAFE' | 'DESKTOP_SAFE' | 'SERVER_RECOMMENDED' | 'SERVER_REQUIRED';

export type RoninWorkloadType = 'COMMAND' | 'APPROVAL' | 'NOTIFICATION' | 'DIAGNOSTIC_SUMMARY' | 'LOCAL_DATABASE' | 'NODE_EXECUTION' | 'CODAGEN' | 'FABRICATION' | 'BULK_ANALYTICS' | 'MULTI_TENANT_COORDINATION';

export type RuntimeDiagnosticSeverity =
  | 'NO_IMPACT'
  | 'MINOR_IMPACT'
  | 'MODERATE_IMPACT'
  | 'MAJOR_IMPACT'
  | 'CRITICAL_IMPACT';

export type RuntimeDiagnosticStatus = 'PASS' | 'WARN' | 'FAIL' | 'NOT_INSTALLED' | 'DISABLED' | 'UNLICENSED';

export type RuntimeCapabilityState = 'AVAILABLE' | 'DEGRADED' | 'BROKEN' | 'MISSING' | 'DISABLED' | 'UNLICENSED';

export type RuntimeRepairRecommendation =
  | 'NO_ACTION_REQUIRED'
  | 'AUTO_REPAIR_AVAILABLE'
  | 'CODAGEN_REPAIR_RECOMMENDED'
  | 'UPGRADE_OR_INSTALL_REQUIRED'
  | 'FOUNDER_REVIEW_REQUIRED'
  | 'KINGMAKER_REVIEW_REQUIRED';

export type VaultCapabilityStatus =
  | 'REQUESTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'DECLINED'
  | 'BUILDING'
  | 'VALIDATING'
  | 'CANONIZED'
  | 'RELEASED'
  | 'RETIRED';

export type VaultOriginType =
  | 'FOUNDER_CREATED'
  | 'RONIN_INTERNAL'
  | 'COMMUNITY_REQUESTED'
  | 'CUSTOMER_SPECIFIC'
  | 'KINGMAKER_SYNTHESIZED';

export interface RoninRuntimeBoundary {
  layer: RoninRuntimeLayer;
  displayName: string;
  purposePlain: string;
  mayConsumeCapability: boolean;
  mayCreateCapability: boolean;
  mayCreateCanonicalNodes: boolean;
  customerFacing: boolean;
  internalOnly: boolean;
}

export interface RoninDeviceRuntimeProfile {
  deviceTier: RoninDeviceTier;
  displayName: string;
  purposePlain: string;
  allowedExecutionWeights: RoninRuntimeWeight[];
  defaultExecutionModeForHeavyWork: RoninExecutionMode;
  supportedWorkloads: RoninWorkloadType[];
  supportsPersistentBackgroundWork: boolean;
  supportsLocalDatabase: boolean;
  supportsLocalNotifications: boolean;
  supportsVoiceEntry: boolean;
  supportsNodeExecution: boolean;
  supportsCodegen: boolean;
  supportsFabricationControl: boolean;
  supportsBulkAnalytics: boolean;
}

export interface DeviceCapabilityRouteInput {
  requestId: string;
  currentDeviceTier: RoninDeviceTier;
  workloadType: RoninWorkloadType;
  requiredWeight: RoninRuntimeWeight;
  offline: boolean;
  desktopAvailable: boolean;
  serverAvailable: boolean;
  connectorAvailable: boolean;
  requiresAuthorityCheck?: boolean;
  authoritySatisfied?: boolean;
}

export interface DeviceCapabilityRouteResult {
  requestId: string;
  executionMode: RoninExecutionMode;
  selectedDeviceTier?: RoninDeviceTier;
  reasonPlain: string;
  queued: boolean;
  requiresSync: boolean;
}

export interface KingmakerClassificationInput {
  requestId: string;
  requestedBy: string;
  organizationId?: string;
  requestPlain: string;
  productClass: RoninProductClass;
  touchesGovernance?: boolean;
  touchesAudit?: boolean;
  exposesRoninIp?: boolean;
  exposesInternalArchitecture?: boolean;
  affectsCrossTenantData?: boolean;
  affectsPrivacy?: boolean;
  affectsRevenueModel?: boolean;
  affectsVaultLaw?: boolean;
  createsLiabilityRisk?: boolean;
  requiresFabrication?: boolean;
  broadCustomerValue?: boolean;
  routineIntegration?: boolean;
}

export interface KingmakerClassificationResult {
  requestId: string;
  riskClass: KingmakerRiskClass;
  canKingmakerApprove: boolean;
  founderReviewRequired: boolean;
  reasonPlain: string;
  nextActionPlain: string;
}

export interface VaultCapabilityRecord {
  nodeId: string;
  displayName: string;
  version: string;
  status: VaultCapabilityStatus;
  originType: VaultOriginType;
  originatingOrganizationName?: string;
  attributionPlain?: string;
  productClass: RoninProductClass;
  riskClass: KingmakerRiskClass;
  runtimeWeight: RoninRuntimeWeight;
  workloadType: RoninWorkloadType;
  minimumDeviceTier: RoninDeviceTier;
  approvedBy: 'KINGMAKER' | 'FOUNDER' | 'NOT_APPROVED';
  canonizedAt?: string;
  releasedAt?: string;
  mayBeSoldAsStandaloneUpsell: false;
  eligibleUsersPlain: string;
}

export interface RuntimeDiagnosticCheck {
  id: string;
  label: string;
  layer: RoninRuntimeLayer;
  status: RuntimeDiagnosticStatus;
  severity: RuntimeDiagnosticSeverity;
  capabilityState: RuntimeCapabilityState;
  causePlain: string;
  impactPlain: string;
  affectedUsersPlain: string;
  affectedWorkflows: string[];
  workaroundPlain?: string;
  recommendedAction: RuntimeRepairRecommendation;
  proofPlain: string;
  checkedAt: string;
}

export interface RuntimeDiagnosticReport {
  reportId: string;
  generatedAt: string;
  triggeredBy: 'STARTUP' | 'TWENTY_FOUR_HOUR_INTERVAL' | 'MAJOR_UPDATE' | 'NEW_CAPABILITY_ATTACHED' | 'MANUAL_REQUEST';
  operationalCapabilityPercent: number;
  criticalIssues: number;
  warnings: number;
  checks: RuntimeDiagnosticCheck[];
  visibleSummaryPlain: string;
}

export const RONIN_DEVICE_RUNTIME_PROFILES: RoninDeviceRuntimeProfile[] = [
  {
    deviceTier: 'PHONE_RUNTIME',
    displayName: 'Phone Runtime',
    purposePlain: 'First-class lightweight command, approval, notification, local cache, offline queue, and executive console runtime.',
    allowedExecutionWeights: ['PHONE_SAFE'],
    defaultExecutionModeForHeavyWork: 'QUEUE_FOR_SYNC',
    supportedWorkloads: ['COMMAND', 'APPROVAL', 'NOTIFICATION', 'DIAGNOSTIC_SUMMARY'],
    supportsPersistentBackgroundWork: false,
    supportsLocalDatabase: true,
    supportsLocalNotifications: true,
    supportsVoiceEntry: true,
    supportsNodeExecution: false,
    supportsCodegen: false,
    supportsFabricationControl: false,
    supportsBulkAnalytics: false,
  },
  {
    deviceTier: 'AVERAGE_DESKTOP_RUNTIME',
    displayName: 'Average Desktop Runtime',
    purposePlain: 'Average laptop or desktop runtime for local database, dashboard, diagnostics, sync, local CodaGen, light automation, and node execution.',
    allowedExecutionWeights: ['PHONE_SAFE', 'DESKTOP_SAFE', 'SERVER_RECOMMENDED'],
    defaultExecutionModeForHeavyWork: 'DELEGATE_TO_SERVER',
    supportedWorkloads: ['COMMAND', 'APPROVAL', 'NOTIFICATION', 'DIAGNOSTIC_SUMMARY', 'LOCAL_DATABASE', 'NODE_EXECUTION', 'CODAGEN'],
    supportsPersistentBackgroundWork: true,
    supportsLocalDatabase: true,
    supportsLocalNotifications: true,
    supportsVoiceEntry: true,
    supportsNodeExecution: true,
    supportsCodegen: true,
    supportsFabricationControl: false,
    supportsBulkAnalytics: false,
  },
  {
    deviceTier: 'OPTIONAL_SERVER_RUNTIME',
    displayName: 'Optional Server Runtime',
    purposePlain: 'Optional infrastructure for fabrication control, bulk analytics, multi-tenant coordination, remote acceleration, and long-running jobs.',
    allowedExecutionWeights: ['PHONE_SAFE', 'DESKTOP_SAFE', 'SERVER_RECOMMENDED', 'SERVER_REQUIRED'],
    defaultExecutionModeForHeavyWork: 'RUN_LOCAL',
    supportedWorkloads: ['COMMAND', 'APPROVAL', 'NOTIFICATION', 'DIAGNOSTIC_SUMMARY', 'LOCAL_DATABASE', 'NODE_EXECUTION', 'FABRICATION', 'BULK_ANALYTICS', 'MULTI_TENANT_COORDINATION'],
    supportsPersistentBackgroundWork: true,
    supportsLocalDatabase: true,
    supportsLocalNotifications: true,
    supportsVoiceEntry: false,
    supportsNodeExecution: true,
    supportsCodegen: false,
    supportsFabricationControl: true,
    supportsBulkAnalytics: true,
  },
];

export const RONIN_RUNTIME_BOUNDARIES: RoninRuntimeBoundary[] = [
  {
    layer: 'CONSTITUTION',
    displayName: 'Ronin Constitution',
    purposePlain: 'Mission, governance, authority, Vault law, escalation, and ownership doctrine.',
    mayConsumeCapability: false,
    mayCreateCapability: false,
    mayCreateCanonicalNodes: false,
    customerFacing: false,
    internalOnly: true,
  },
  {
    layer: 'KINGMAKER',
    displayName: 'Kingmaker',
    purposePlain: 'Internal Ronin administrative plane. Consumes and creates capabilities.',
    mayConsumeCapability: true,
    mayCreateCapability: true,
    mayCreateCanonicalNodes: true,
    customerFacing: false,
    internalOnly: true,
  },
  {
    layer: 'VAULT',
    displayName: 'Vault',
    purposePlain: 'Accumulated canon capability store for Ronin and Solomon.',
    mayConsumeCapability: false,
    mayCreateCapability: false,
    mayCreateCanonicalNodes: false,
    customerFacing: false,
    internalOnly: true,
  },
  {
    layer: 'SOLOMON_RUNTIME',
    displayName: 'Solomon Runtime',
    purposePlain: 'Customer-facing governed orchestration runtime. Consumes canon capabilities.',
    mayConsumeCapability: true,
    mayCreateCapability: false,
    mayCreateCanonicalNodes: false,
    customerFacing: true,
    internalOnly: false,
  },
  {
    layer: 'ORB_RUNTIME',
    displayName: 'Orb Runtime',
    purposePlain: 'Primary user interface for voice, conversation, diagnostics, notifications, and command.',
    mayConsumeCapability: true,
    mayCreateCapability: false,
    mayCreateCanonicalNodes: false,
    customerFacing: true,
    internalOnly: false,
  },
  {
    layer: 'DAEMON_RUNTIME',
    displayName: 'Daemon Runtime',
    purposePlain: 'Tier-aware supervisor runtime. Lightweight on phone, persistent on desktop/server.',
    mayConsumeCapability: true,
    mayCreateCapability: false,
    mayCreateCanonicalNodes: false,
    customerFacing: false,
    internalOnly: false,
  },
];

export function classifyKingmakerRequest(input: KingmakerClassificationInput): KingmakerClassificationResult {
  const redReasons: string[] = [];

  if (input.touchesGovernance) redReasons.push('governance modification');
  if (input.touchesAudit) redReasons.push('audit modification');
  if (input.exposesRoninIp) redReasons.push('Ronin IP exposure');
  if (input.exposesInternalArchitecture) redReasons.push('internal architecture exposure');
  if (input.affectsCrossTenantData) redReasons.push('cross-tenant data risk');
  if (input.affectsPrivacy) redReasons.push('privacy impact');
  if (input.affectsRevenueModel) redReasons.push('revenue model impact');
  if (input.affectsVaultLaw) redReasons.push('Vault law impact');
  if (input.createsLiabilityRisk) redReasons.push('liability risk');

  if (redReasons.length > 0) {
    return {
      requestId: input.requestId,
      riskClass: 'RED',
      canKingmakerApprove: false,
      founderReviewRequired: true,
      reasonPlain: `Founder review required because request touches ${redReasons.join(', ')}.`,
      nextActionPlain: 'Escalate to founder through Kingmaker before build or release.',
    };
  }

  if (input.requiresFabrication || input.productClass === 'HYBRID_INCUBATION') {
    return {
      requestId: input.requestId,
      riskClass: 'YELLOW',
      canKingmakerApprove: false,
      founderReviewRequired: true,
      reasonPlain: 'Request may be useful but requires founder review before canonization or release.',
      nextActionPlain: 'Prepare feasibility brief, risk summary, and proposed build plan for founder review.',
    };
  }

  return {
    requestId: input.requestId,
    riskClass: 'GREEN',
    canKingmakerApprove: true,
    founderReviewRequired: false,
    reasonPlain: 'Request appears useful, low-risk, and within delegated Kingmaker authority.',
    nextActionPlain: 'Approve for Kingmaker build queue, validation, attribution, and release preparation.',
  };
}

export function routeDeviceCapability(input: DeviceCapabilityRouteInput): DeviceCapabilityRouteResult {
  if (input.requiresAuthorityCheck && !input.authoritySatisfied) {
    return {
      requestId: input.requestId,
      executionMode: 'BLOCKED',
      reasonPlain: 'Execution blocked because authority requirements are not satisfied.',
      queued: false,
      requiresSync: false,
    };
  }

  if (input.offline) {
    return {
      requestId: input.requestId,
      executionMode: input.requiredWeight === 'PHONE_SAFE' ? 'QUEUE_FOR_SYNC' : 'ADVISORY_ONLY',
      selectedDeviceTier: input.currentDeviceTier,
      reasonPlain: 'Device is offline. Phone-safe requests are queued; heavier requests degrade to advisory mode until sync is available.',
      queued: input.requiredWeight === 'PHONE_SAFE',
      requiresSync: true,
    };
  }

  if (input.workloadType === 'FABRICATION') {
    if (input.serverAvailable) {
      return {
        requestId: input.requestId,
        executionMode: 'DELEGATE_TO_SERVER',
        selectedDeviceTier: 'OPTIONAL_SERVER_RUNTIME',
        reasonPlain: 'Fabrication control is delegated to optional server or dedicated fabrication host runtime.',
        queued: true,
        requiresSync: true,
      };
    }

    return {
      requestId: input.requestId,
      executionMode: 'ADVISORY_ONLY',
      selectedDeviceTier: input.currentDeviceTier,
      reasonPlain: 'Fabrication requires a dedicated host/server runtime. No fabrication host is available, so Solomon degrades to advisory mode.',
      queued: false,
      requiresSync: false,
    };
  }

  if (input.workloadType === 'CODAGEN') {
    if (input.currentDeviceTier === 'AVERAGE_DESKTOP_RUNTIME') {
      return {
        requestId: input.requestId,
        executionMode: 'RUN_LOCAL',
        selectedDeviceTier: 'AVERAGE_DESKTOP_RUNTIME',
        reasonPlain: 'CodaGen is a local desktop workload by default.',
        queued: false,
        requiresSync: false,
      };
    }

    if (input.desktopAvailable) {
      return {
        requestId: input.requestId,
        executionMode: 'DELEGATE_TO_DESKTOP',
        selectedDeviceTier: 'AVERAGE_DESKTOP_RUNTIME',
        reasonPlain: 'CodaGen is delegated to the local desktop runtime, not server-first infrastructure.',
        queued: true,
        requiresSync: true,
      };
    }

    return {
      requestId: input.requestId,
      executionMode: 'ADVISORY_ONLY',
      selectedDeviceTier: input.currentDeviceTier,
      reasonPlain: 'CodaGen requires local desktop runtime. No desktop runtime is available.',
      queued: false,
      requiresSync: false,
    };
  }

  if (input.currentDeviceTier === 'PHONE_RUNTIME') {
    if (input.requiredWeight === 'PHONE_SAFE') {
      return {
        requestId: input.requestId,
        executionMode: 'RUN_LOCAL',
        selectedDeviceTier: 'PHONE_RUNTIME',
        reasonPlain: 'Request is phone-safe and may run locally.',
        queued: false,
        requiresSync: false,
      };
    }

    if (input.desktopAvailable) {
      return {
        requestId: input.requestId,
        executionMode: 'DELEGATE_TO_DESKTOP',
        selectedDeviceTier: 'AVERAGE_DESKTOP_RUNTIME',
        reasonPlain: 'Request exceeds phone-safe limits and will be delegated to desktop runtime.',
        queued: true,
        requiresSync: true,
      };
    }

    if (input.serverAvailable) {
      return {
        requestId: input.requestId,
        executionMode: 'DELEGATE_TO_SERVER',
        selectedDeviceTier: 'OPTIONAL_SERVER_RUNTIME',
        reasonPlain: 'Request exceeds phone-safe limits and will be delegated to optional server runtime.',
        queued: true,
        requiresSync: true,
      };
    }

    return {
      requestId: input.requestId,
      executionMode: 'ADVISORY_ONLY',
      selectedDeviceTier: 'PHONE_RUNTIME',
      reasonPlain: 'Request exceeds phone-safe limits and no desktop/server runtime is available. Advisory mode only.',
      queued: false,
      requiresSync: false,
    };
  }

  if (input.currentDeviceTier === 'AVERAGE_DESKTOP_RUNTIME') {
    if (input.requiredWeight === 'PHONE_SAFE' || input.requiredWeight === 'DESKTOP_SAFE' || input.requiredWeight === 'SERVER_RECOMMENDED') {
      return {
        requestId: input.requestId,
        executionMode: 'RUN_LOCAL',
        selectedDeviceTier: 'AVERAGE_DESKTOP_RUNTIME',
        reasonPlain: 'Request is safe for average desktop runtime. Server remains optional acceleration only.',
        queued: false,
        requiresSync: false,
      };
    }

    if (input.serverAvailable) {
      return {
        requestId: input.requestId,
        executionMode: 'DELEGATE_TO_SERVER',
        selectedDeviceTier: 'OPTIONAL_SERVER_RUNTIME',
        reasonPlain: 'Request exceeds average desktop limits and will be delegated to server runtime.',
        queued: true,
        requiresSync: true,
      };
    }

    return {
      requestId: input.requestId,
      executionMode: 'ADVISORY_ONLY',
      selectedDeviceTier: 'AVERAGE_DESKTOP_RUNTIME',
      reasonPlain: 'Request exceeds average desktop limits and no server runtime is available. Advisory mode only.',
      queued: false,
      requiresSync: false,
    };
  }

  return {
    requestId: input.requestId,
    executionMode: 'RUN_LOCAL',
    selectedDeviceTier: 'OPTIONAL_SERVER_RUNTIME',
    reasonPlain: 'Optional server runtime can execute requested workload.',
    queued: false,
    requiresSync: false,
  };
}

export function createVisibleDiagnosticSummary(report: RuntimeDiagnosticReport): string {
  const coreState = report.criticalIssues === 0 ? 'Core systems operational' : 'Critical issue detected';
  return `Solomon verified: ${coreState}. Operational capability ${report.operationalCapabilityPercent}%. Critical issues ${report.criticalIssues}. Warnings ${report.warnings}.`;
}

export function recommendRepairForDiagnostic(check: RuntimeDiagnosticCheck): RuntimeRepairRecommendation {
  if (check.status === 'PASS') return 'NO_ACTION_REQUIRED';
  if (check.capabilityState === 'UNLICENSED' || check.capabilityState === 'MISSING') return 'UPGRADE_OR_INSTALL_REQUIRED';
  if (check.capabilityState === 'BROKEN') return 'CODAGEN_REPAIR_RECOMMENDED';
  if (check.severity === 'CRITICAL_IMPACT') return 'KINGMAKER_REVIEW_REQUIRED';
  return check.recommendedAction;
}
