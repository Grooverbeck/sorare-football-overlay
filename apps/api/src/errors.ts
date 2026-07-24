export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'AppError';
  }
}
