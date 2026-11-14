// Ronin / Solomon — Open Dev Hall of Fame + Public Idea Pot Schema v1
// Contributors receive durable recognition. Kingmaker draws one public idea weekly, announces it when drawn,
// tracks completion, and exposes public release telemetry for ronininc.org.

import type { KingmakerRiskClass } from './runtime-sovereignty';
import type { CapabilityAuthorityLevel } from './capability-manifest';

export type OpenDevContributorType = 'PERSON' | 'COMPANY' | 'TEAM';

export type OpenDevIdeaStatus =
  | 'SUBMITTED'
  | 'ELIGIBLE_FOR_DRAW'
  | 'DRAWN'
  | 'UNDER_KINGMAKER_REVIEW'
  | 'APPROVED_FOR_BUILD'
  | 'BUILDING'
  | 'VALIDATING'
  | 'RELEASED'
  | 'DECLINED'
  | 'ARCHIVED';

export type OpenDevAnnouncementType = 'DRAWN' | 'APPROVED' | 'BUILD_STARTED' | 'RELEASED' | 'DECLINED';

export interface OpenDevContributorRecord {
  contributorId: string;
  displayName: string;
  contributorType: OpenDevContributorType;
  organizationName?: string;
  joinedAt: string;
  hallOfFameVisible: boolean;
  contributionCount: number;
  releasedContributionCount: number;
  publicCreditPlain: string;
}

export interface OpenDevIdeaRecord {
  ideaId: string;
  submittedByContributorId: string;
  submittedByDisplayName: string;
  submittedByOrganizationName?: string;
  title: string;
  descriptionPlain: string;
  status: OpenDevIdeaStatus;
  riskClass: KingmakerRiskClass;
  authorityRequired: CapabilityAuthorityLevel;
  submittedAt: string;
  drawnAt?: string;
  releasedAt?: string;
  estimatedCompletionAt?: string;
  kingmakerEstimatePlain?: string;
  roninWatermark: 'Ronin Inc.';
  contributorWatermark: string;
  noPriceIncreaseFromContribution: true;
  proprietaryToRonin: true;
  publicAnnouncementAllowed: boolean;
}

export interface OpenDevWeeklyDrawRecord {
  drawId: string;
  drawWeekIso: string;
  drawnAt: string;
  drawnBy: 'KINGMAKER' | 'FOUNDER';
  selectedIdeaId: string;
  selectedTitle: string;
  selectedContributorDisplayName: string;
  selectedContributorOrganizationName?: string;
  announcementPlain: string;
}

export interface RoninPublicExpansionTelemetry {
  generatedAt: string;
  timeSinceLastPublicIdeaReleaseMs: number;
  publicContributionExpansionCount: number;
  activeDrawnIdeaId?: string;
  activeDrawnIdeaTitle?: string;
  activeContributorCreditPlain?: string;
  nextEstimatedCompletionAt?: string;
  nextEstimatedCompletionPlain?: string;
  kingmakerBasisPlain: string;
}

export function createOpenDevIdea(input: {
  ideaId: string;
  contributorId: string;
  contributorDisplayName: string;
  contributorOrganizationName?: string;
  title: string;
  descriptionPlain: string;
  submittedAt: string;
}): OpenDevIdeaRecord {
  return {
    ideaId: input.ideaId,
    submittedByContributorId: input.contributorId,
    submittedByDisplayName: input.contributorDisplayName,
    submittedByOrganizationName: input.contributorOrganizationName,
    title: input.title,
    descriptionPlain: input.descriptionPlain,
    status: 'SUBMITTED',
    riskClass: 'YELLOW',
    authorityRequired: 'USER',
    submittedAt: input.submittedAt,
    roninWatermark: 'Ronin Inc.',
    contributorWatermark: input.contributorOrganizationName ?? input.contributorDisplayName,
    noPriceIncreaseFromContribution: true,
    proprietaryToRonin: true,
    publicAnnouncementAllowed: true,
  };
}

export function canEnterWeeklyIdeaPot(idea: OpenDevIdeaRecord): boolean {
  if (!idea.publicAnnouncementAllowed) return false;
  if (idea.proprietaryToRonin !== true) return false;
  if (idea.noPriceIncreaseFromContribution !== true) return false;
  if (idea.roninWatermark !== 'Ronin Inc.') return false;
  if (!idea.contributorWatermark) return false;
  return idea.status === 'SUBMITTED' || idea.status === 'ELIGIBLE_FOR_DRAW';
}

export function markIdeaDrawn(input: {
  idea: OpenDevIdeaRecord;
  drawnAt: string;
  estimatedCompletionAt?: string;
  kingmakerEstimatePlain?: string;
}): OpenDevIdeaRecord {
  return {
    ...input.idea,
    status: 'DRAWN',
    drawnAt: input.drawnAt,
    estimatedCompletionAt: input.estimatedCompletionAt,
    kingmakerEstimatePlain: input.kingmakerEstimatePlain,
  };
}

export function createWeeklyDrawAnnouncement(draw: OpenDevWeeklyDrawRecord): string {
  return `This week's Solomon Open Dev draw: ${draw.selectedTitle}. Contributor: ${draw.selectedContributorDisplayName}${draw.selectedContributorOrganizationName ? ` / ${draw.selectedContributorOrganizationName}` : ''}. Governed by Ronin Inc.`;
}

export function createReleaseAnnouncement(idea: OpenDevIdeaRecord): string {
  return `Released: ${idea.title}. Built with Solomon. Governed by Ronin Inc. Contribution credited to ${idea.contributorWatermark}.`;
}

export function createPublicExpansionTelemetry(input: {
  generatedAt: string;
  lastPublicIdeaReleasedAt?: string;
  publicContributionExpansionCount: number;
  activeDrawnIdea?: OpenDevIdeaRecord;
  kingmakerBasisPlain: string;
}): RoninPublicExpansionTelemetry {
  const lastRelease = input.lastPublicIdeaReleasedAt ? new Date(input.lastPublicIdeaReleasedAt).getTime() : new Date(input.generatedAt).getTime();
  const now = new Date(input.generatedAt).getTime();
  const active = input.activeDrawnIdea;

  return {
    generatedAt: input.generatedAt,
    timeSinceLastPublicIdeaReleaseMs: Math.max(0, now - lastRelease),
    publicContributionExpansionCount: input.publicContributionExpansionCount,
    activeDrawnIdeaId: active?.ideaId,
    activeDrawnIdeaTitle: active?.title,
    activeContributorCreditPlain: active ? `Contributor: ${active.contributorWatermark}` : undefined,
    nextEstimatedCompletionAt: active?.estimatedCompletionAt,
    nextEstimatedCompletionPlain: active?.kingmakerEstimatePlain,
    kingmakerBasisPlain: input.kingmakerBasisPlain,
  };
}
