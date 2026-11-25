export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, exitCode = 2, hint?: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}
