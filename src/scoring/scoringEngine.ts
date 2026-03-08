import { ApplicationInput, FactorBreakdown, ScoreResult } from '../domain/types';
import { decisionFromScore, scoringConfig, ScoringConfig } from '../config/scoring';

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function scoreIncomeVerification(input: ApplicationInput, cfg: ScoringConfig): number {
  const { documented_monthly_income, stated_monthly_income } = input;
  const { weight, tolerancePercent, missingScore, outsideToleranceScore } = cfg.incomeVerification;

  if (documented_monthly_income == null) {
    return missingScore;
  }

  if (stated_monthly_income <= 0) {
    return outsideToleranceScore;
  }

  const diff = Math.abs(documented_monthly_income - stated_monthly_income);
  const diffPercent = (diff / stated_monthly_income) * 100;

  if (diffPercent <= tolerancePercent) {
    return weight;
  }

  return outsideToleranceScore;
}

function scoreIncomeLevel(input: ApplicationInput, cfg: ScoringConfig): number {
  const { loan_amount, documented_monthly_income, stated_monthly_income } = input;
  const { weight, incomeMultipleThreshold, missingScore } = cfg.incomeLevel;

  const income = documented_monthly_income ?? stated_monthly_income;
  if (income == null || income <= 0) {
    return missingScore;
  }

  const requiredIncome = loan_amount * incomeMultipleThreshold;
  if (requiredIncome <= 0) {
    return weight;
  }

  if (income >= requiredIncome) {
    return weight;
  }

  // const ratio = income / requiredIncome;
  // return clamp(weight * ratio, 0, weight);
  return 0;
}

function scoreAccountStability(input: ApplicationInput, cfg: ScoringConfig): number {
  const {
    bank_ending_balance,
    bank_has_overdrafts,
    bank_has_consistent_deposits,
  } = input;
  const {
    weight,
    positiveBalanceScore,
    noOverdraftsScore,
    consistentDepositsScore,
  } = cfg.accountStability;

  let score = 0;

  if (bank_ending_balance != null && bank_ending_balance > 0) {
    score += positiveBalanceScore;
  }

  if (bank_has_overdrafts === false) {
    score += noOverdraftsScore;
  }

  if (bank_has_consistent_deposits === true) {
    score += consistentDepositsScore;
  }

  return clamp(score, 0, weight);
}

function scoreEmploymentStatus(input: ApplicationInput, cfg: ScoringConfig): number {
  const { employment_status } = input;
  const { weight, scores } = cfg.employmentStatus;
  const raw = scores[employment_status] ?? scores.default ?? weight / 2;
  return clamp(raw, 0, weight);
}

function scoreDebtToIncome(input: ApplicationInput, cfg: ScoringConfig): number {
  const { monthly_withdrawals, monthly_deposits } = input;
  const { weight, idealRatio, maxRatio, missingScore } = cfg.debtToIncome;

  if (monthly_withdrawals == null || monthly_deposits == null || monthly_deposits <= 0) {
    return missingScore;
  }

  const ratio = monthly_withdrawals / monthly_deposits;

  if (ratio <= idealRatio) return weight;
  if (ratio >= maxRatio) return 0;

  // between idealRatio and maxRatio score is linear decrease to 0
  const score = weight * (1 - (ratio - idealRatio) / (maxRatio - idealRatio));
  return Math.round(Math.min(Math.max(score, 0), weight) * 1000) / 1000;
}


export function scoreApplication(
  input: ApplicationInput,
  cfg: ScoringConfig = scoringConfig,
): ScoreResult {
  const incomeVerification = scoreIncomeVerification(input, cfg);
  const incomeLevel = scoreIncomeLevel(input, cfg);
  const accountStability = scoreAccountStability(input, cfg);
  const employmentStatus = scoreEmploymentStatus(input, cfg);
  const debtToIncome = scoreDebtToIncome(input, cfg);

  const factors: FactorBreakdown = {
    incomeVerification,
    incomeLevel,
    accountStability,
    employmentStatus,
    debtToIncome,
  };

  const totalScore =
    incomeVerification +
    incomeLevel +
    accountStability +
    employmentStatus +
    debtToIncome;

  const decision = decisionFromScore(totalScore);

  return {
    totalScore,
    factors,
    decision,
  };
}

