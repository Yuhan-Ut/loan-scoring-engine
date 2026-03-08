export type EmploymentStatus = 'employed' | 'self-employed' | 'unemployed';

export interface ApplicationInput {
  applicant_name: string;
  email: string;
  loan_amount: number;
  stated_monthly_income: number;
  employment_status: EmploymentStatus;
  documented_monthly_income: number | null;
  bank_ending_balance: number | null;
  bank_has_overdrafts: boolean | null;
  bank_has_consistent_deposits: boolean | null;
  monthly_withdrawals: number | null;
  monthly_deposits: number | null;
}

export type ScoreDecision = 'auto_approve' | 'manual_review' | 'auto_deny';

export interface FactorBreakdown {
  incomeVerification: number;
  incomeLevel: number;
  accountStability: number;
  employmentStatus: number;
  debtToIncome: number;
}

export interface ScoreResult {
  totalScore: number;
  factors: FactorBreakdown;
  decision: ScoreDecision;
}

