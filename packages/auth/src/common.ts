export interface Clock {
  now(): number;
}

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
});

export class AuthenticationError extends Error {
  readonly code = 'AUTHENTICATION_FAILED';

  constructor() {
    super('authentication failed');
    this.name = 'AuthenticationError';
  }
}

export class CredentialOperationError extends Error {
  readonly code = 'CREDENTIAL_OPERATION_FAILED';

  constructor() {
    super('credential operation failed');
    this.name = 'CredentialOperationError';
  }
}

export class AuthorizationError extends Error {
  readonly code = 'RESOURCE_NOT_VISIBLE';

  constructor() {
    super('resource is not visible');
    this.name = 'AuthorizationError';
  }
}

export function authenticationFailed(): never {
  throw new AuthenticationError();
}

export function credentialOperationFailed(): never {
  throw new CredentialOperationError();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
