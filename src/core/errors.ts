export class OccError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export const forbidden = () => new OccError('FORBIDDEN', 'Not authorized', 403);
