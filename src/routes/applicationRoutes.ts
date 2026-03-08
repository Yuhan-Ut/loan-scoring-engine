import { Router } from 'express';
import { createApplication } from '../services/applicationService';
import { ValidationError, DuplicateApplicationError } from '../domain/errors';
import { ApplicationInput } from '../domain/types';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const body = req.body as Partial<ApplicationInput>;

    if (
      !body.applicant_name ||
      !body.email ||
      typeof body.loan_amount !== 'number' ||
      typeof body.stated_monthly_income !== 'number' ||
      !body.employment_status
    ) {
      throw new ValidationError('Missing required fields for application');
    }

    const input: ApplicationInput = {
      applicant_name: body.applicant_name,
      email: body.email,
      loan_amount: body.loan_amount,
      stated_monthly_income: body.stated_monthly_income,
      employment_status: body.employment_status,
      documented_monthly_income: body.documented_monthly_income ?? null,
      bank_ending_balance: body.bank_ending_balance ?? null,
      bank_has_overdrafts:
        typeof body.bank_has_overdrafts === 'boolean' ? body.bank_has_overdrafts : null,
      bank_has_consistent_deposits:
        typeof body.bank_has_consistent_deposits === 'boolean'
          ? body.bank_has_consistent_deposits
          : null,
      monthly_withdrawals: body.monthly_withdrawals ?? null,
      monthly_deposits: body.monthly_deposits ?? null,
    };

    const result = await createApplication(input);

    res.status(201).json({
      application_id: result.id,
      status: result.status,
      score: result.score,
      score_breakdown: result.scoreResult.factors,
      decision: result.scoreResult.decision,
    });
  } catch (err) {
    if (err instanceof DuplicateApplicationError) {
      res.status(409).json({
        error_type: err.name,
        message: err.message,
        original_application_id: err.originalApplicationId,
      });
      return;
    }

    next(err);
  }
});

export const applicationRoutes = router;

