export class FrameValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameValidationError';
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new FrameValidationError(message);
  }
}
