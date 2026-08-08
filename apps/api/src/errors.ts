export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class UpstreamError extends AppError {
  constructor(service: string, message: string, details?: Record<string, unknown>) {
    super(503, 'UPSTREAM_UNAVAILABLE', `${service}: ${message}`, details);
  }
}
