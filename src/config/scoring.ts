import { ScoreDecision } from '../domain/types';

export type ScoreDecisionConfig = {
  autoApproveMin: number;
  manualReviewMin: number;
};

export interface ScoringConfig {
  incomeVerification: {
    weight: number;
    tolerancePercent: number;
    missingScore: number;
    outsideToleranceScore: number;
  };
  incomeLevel: {
    weight: number;
    incomeMultipleThreshold: number;
    missingScore: number;
  };
  accountStability: {
    weight: number;
    positiveBalanceScore: number;
    noOverdraftsScore: number;
    consistentDepositsScore: number;
  };
  employmentStatus: {
    weight: number;
    scores: Record<string, number>;
  };
  debtToIncome: {
    weight: number;
    idealRatio: number;
    maxRatio: number; 
    missingScore: number;
  };
  decisionThresholds: ScoreDecisionConfig;
}

export const scoringConfig: ScoringConfig = {
  incomeVerification: {
    weight: 30,
    tolerancePercent: 10,
    // If documents are missing, give a medium score so cases tend to go to manual review.
    missingScore: 15,
    // If documented income is outside the tolerance band, treat as failed verification.
    outsideToleranceScore: 0,
  },
  incomeLevel: {
    weight: 25,
    incomeMultipleThreshold: 3,
    // Missing income information should push toward manual review.
    missingScore: 10,
  },
  accountStability: {
    weight: 20,
    positiveBalanceScore: 6,
    noOverdraftsScore: 6,
    consistentDepositsScore: 8,
  },
  employmentStatus: {
    weight: 15,
    scores: {
      employed: 15,
      'self-employed': 8,
      unemployed: 3,
      default: 5,
    },
  },
  debtToIncome: {
    weight: 10,
    idealRatio: 0.2,    
    maxRatio: 0.8,
    missingScore: 0,
  },
  decisionThresholds: {
    autoApproveMin: 75,
    manualReviewMin: 50,
  },
};

export function decisionFromScore(score: number, cfg: ScoreDecisionConfig = scoringConfig.decisionThresholds): ScoreDecision {
  if (score >= cfg.autoApproveMin) {
    return 'auto_approve';
  }
  if (score >= cfg.manualReviewMin) {
    return 'manual_review';
  }
  return 'auto_deny';
}

