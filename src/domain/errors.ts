export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly applicationId: string,
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(`Invalid state transition from "${fromStatus}" to "${toStatus}" for application "${applicationId}"`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class DuplicateApplicationError extends Error {
  constructor(
    public readonly email: string,
    public readonly loanAmount: number,
    public readonly originalApplicationId: string,
  ) {
    super(`Duplicate application for ${email} and amount ${loanAmount}, original id: ${originalApplicationId}`);
    this.name = 'DuplicateApplicationError';
  }
}

export class WebhookReplayError extends Error {
  constructor(
    public readonly applicationId: string,
    public readonly transactionId: string,
  ) {
    super(`Webhook replay for application "${applicationId}" and transaction "${transactionId}"`);
    this.name = 'WebhookReplayError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

