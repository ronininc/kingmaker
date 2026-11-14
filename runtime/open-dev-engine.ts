// Ronin / Solomon — Open Dev Engine Runtime v1
// Recognition, idea pot, weekly draw, and public expansion telemetry.

import {
  canEnterWeeklyIdeaPot,
  createOpenDevIdea,
  createPublicExpansionTelemetry,
  createReleaseAnnouncement,
  createWeeklyDrawAnnouncement,
  markIdeaDrawn,
  type OpenDevIdeaRecord,
  type OpenDevWeeklyDrawRecord,
  type RoninPublicExpansionTelemetry,
} from '../contracts/open-dev-hall-of-fame';

export interface OpenDevEngineResult {
  ok: boolean;
  idea?: OpenDevIdeaRecord;
  telemetry?: RoninPublicExpansionTelemetry;
  announcementPlain?: string;
  reasonPlain: string;
}

export function submitOpenDevIdea(input: Parameters<typeof createOpenDevIdea>[0]): OpenDevEngineResult {
  const idea = createOpenDevIdea(input);

  return {
    ok: true,
    idea,
    reasonPlain: 'Open Dev idea submitted with Ronin and contributor watermark preserved.',
  };
}

export function qualifyIdeaForWeeklyPot(idea: OpenDevIdeaRecord): OpenDevEngineResult {
  if (!canEnterWeeklyIdeaPot(idea)) {
    return {
      ok: false,
      idea,
      reasonPlain: 'Idea cannot enter weekly pot because attribution, ownership, or public eligibility requirements are not satisfied.',
    };
  }

  return {
    ok: true,
    idea: {
      ...idea,
      status: 'ELIGIBLE_FOR_DRAW',
    },
    reasonPlain: 'Idea is eligible for weekly public draw.',
  };
}

export function drawWeeklyIdea(input: {
  idea: OpenDevIdeaRecord;
  draw: OpenDevWeeklyDrawRecord;
  estimatedCompletionAt?: string;
  kingmakerEstimatePlain?: string;
}): OpenDevEngineResult {
  if (!canEnterWeeklyIdeaPot(input.idea) && input.idea.status !== 'ELIGIBLE_FOR_DRAW') {
    return {
      ok: false,
      idea: input.idea,
      reasonPlain: 'Idea is not eligible for weekly draw.',
    };
  }

  const idea = markIdeaDrawn({
    idea: input.idea,
    drawnAt: input.draw.drawnAt,
    estimatedCompletionAt: input.estimatedCompletionAt,
    kingmakerEstimatePlain: input.kingmakerEstimatePlain,
  });

  return {
    ok: true,
    idea,
    announcementPlain: createWeeklyDrawAnnouncement(input.draw),
    reasonPlain: 'Weekly idea drawn and announcement prepared.',
  };
}

export function releaseOpenDevIdea(idea: OpenDevIdeaRecord): OpenDevEngineResult {
  const releasedIdea: OpenDevIdeaRecord = {
    ...idea,
    status: 'RELEASED',
    releasedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    idea: releasedIdea,
    announcementPlain: createReleaseAnnouncement(releasedIdea),
    reasonPlain: 'Open Dev idea released with contributor credit preserved.',
  };
}

export function generateOpenDevTelemetry(input: Parameters<typeof createPublicExpansionTelemetry>[0]): OpenDevEngineResult {
  return {
    ok: true,
    telemetry: createPublicExpansionTelemetry(input),
    reasonPlain: 'Public expansion telemetry generated for ronininc.org.',
  };
}
