export type TurnOwner = 'sender' | 'receiver';

export class SessionControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionControllerError';
  }
}
