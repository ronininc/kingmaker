// Ronin / Solomon — Vault Registry Schema v1
// Vault stores capabilities and systems, not customer data. Customer-created systems receive Ronin Inc. watermark and contributor watermark without price increase.

import type {
  KingmakerRiskClass,
  RoninDeviceTier,
  RoninProductClass,
  RoninRuntimeWeight,
  RoninWorkloadType,
} from './runtime-sovereignty';
import type { CapabilityAuthorityLevel } from './capability-manifest';

export type VaultEntryStatus =
  | 'REQUESTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'BUILDING'
  | 'VALIDATING'
  | 'CANON'
  | 'RELEASED'
  | 'DEPRECATED'
  | 'RETIRED';

export type VaultEntryOrigin =
  | 'FOUNDER_CREATED'
  | 'RONIN_INTERNAL'
  | 'CUSTOMER_CREATED_USING_SOLOMON'
  | 'COMMUNITY_ENHANCEMENT'
  | 'KINGMAKER_SYNTHESIZED'
  | 'IMPORT';

export type VaultWatermarkVisibility = 'INTERNAL_ONLY' | 'CUSTOMER_VISIBLE' | 'PUBLIC_RELEASE_NOTES';

export interface VaultWatermarkRecord {
  roninWatermark: 'Ronin Inc.';
  contributorCompanyWatermark?: string;
  visibility: VaultWatermarkVisibility;
  creditPlain: string;
  ownershipPlain: string;
  priceIncreaseAllowed: false;
}

export interface VaultDependencyRecord {
  capabilityId: string;
  versionRangePlain: string;
  required: boolean;
  reasonPlain: string;
}

export interface VaultReleaseRecord {
  releaseId: string;
  version: string;
  releasedAt: string;
  releasedBy: 'KINGMAKER' | 'FOUNDER';
  releaseNotesPlain: string;
  eligibleUsersPlain: string;
}

export interface VaultRegistryEntryV1 {
  schemaVersion: '1.0';
  vaultId: string;
  capabilityId: string;
  displayName: string;
  descriptionPlain: string;
  version: string;
  status: VaultEntryStatus;
  origin: VaultEntryOrigin;
  productClass: RoninProductClass;
  riskClass: KingmakerRiskClass;
  workloadType: RoninWorkloadType;
  runtimeWeight: RoninRuntimeWeight;
  minimumDeviceTier: RoninDeviceTier;
  authorityRequired: CapabilityAuthorityLevel;
  originatingOrganizationId?: string;
  originatingOrganizationName?: string;
  createdUsingSolomon: boolean;
  proprietaryToRonin: true;
  customerDataIncluded: false;
  mayBeSoldAsStandaloneUpsell: false;
  noPriceIncreaseFromContribution: true;
  watermark: VaultWatermarkRecord;
  dependencies: VaultDependencyRecord[];
  releases: VaultReleaseRecord[];
  approvedBy: 'KINGMAKER' | 'FOUNDER' | 'NOT_APPROVED';
  approvedAt?: string;
  canonizedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerCreatedVaultEntryInput {
  vaultId: string;
  capabilityId: string;
  displayName: string;
  descriptionPlain: string;
  version: string;
  productClass: RoninProductClass;
  riskClass: KingmakerRiskClass;
  workloadType: RoninWorkloadType;
  runtimeWeight: RoninRuntimeWeight;
  minimumDeviceTier: RoninDeviceTier;
  authorityRequired: CapabilityAuthorityLevel;
  originatingOrganizationId: string;
  originatingOrganizationName: string;
  createdAt: string;
}

export function createCustomerCreatedVaultEntry(input: CustomerCreatedVaultEntryInput): VaultRegistryEntryV1 {
  return {
    schemaVersion: '1.0',
    vaultId: input.vaultId,
    capabilityId: input.capabilityId,
    displayName: input.displayName,
    descriptionPlain: input.descriptionPlain,
    version: input.version,
    status: 'UNDER_REVIEW',
    origin: 'CUSTOMER_CREATED_USING_SOLOMON',
    productClass: input.productClass,
    riskClass: input.riskClass,
    workloadType: input.workloadType,
    runtimeWeight: input.runtimeWeight,
    minimumDeviceTier: input.minimumDeviceTier,
    authorityRequired: input.authorityRequired,
    originatingOrganizationId: input.originatingOrganizationId,
    originatingOrganizationName: input.originatingOrganizationName,
    createdUsingSolomon: true,
    proprietaryToRonin: true,
    customerDataIncluded: false,
    mayBeSoldAsStandaloneUpsell: false,
    noPriceIncreaseFromContribution: true,
    watermark: {
      roninWatermark: 'Ronin Inc.',
      contributorCompanyWatermark: input.originatingOrganizationName,
      visibility: 'CUSTOMER_VISIBLE',
      creditPlain: `Built with Solomon by ${input.originatingOrganizationName}. Canon governed by Ronin Inc.`,
      ownershipPlain: 'System capability becomes a proprietary governed Solomon capability while preserving contributor credit. Customer data is not included in Vault.',
      priceIncreaseAllowed: false,
    },
    dependencies: [],
    releases: [],
    approvedBy: 'NOT_APPROVED',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function canChargeAdditionalPriceForVaultContribution(entry: VaultRegistryEntryV1): false {
  return false;
}

export function hasRequiredWatermarks(entry: VaultRegistryEntryV1): boolean {
  if (entry.watermark.roninWatermark !== 'Ronin Inc.') return false;
  if (entry.origin === 'CUSTOMER_CREATED_USING_SOLOMON' && !entry.watermark.contributorCompanyWatermark) return false;
  return true;
}

export function canCanonizeVaultEntry(entry: VaultRegistryEntryV1): boolean {
  if (!hasRequiredWatermarks(entry)) return false;
  if (entry.customerDataIncluded !== false) return false;
  if (entry.proprietaryToRonin !== true) return false;
  if (entry.mayBeSoldAsStandaloneUpsell !== false) return false;
  if (entry.noPriceIncreaseFromContribution !== true) return false;
  if (entry.approvedBy === 'NOT_APPROVED') return false;
  return entry.status === 'VALIDATING' || entry.status === 'APPROVED';
}
