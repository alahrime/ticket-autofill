// Errors of the api layer, mapped to replies in app.ts: NotFound -> 404, BadInput -> 400, Gone -> no reply.

/** No such record (Python's KeyError for an unknown ticket id). */
export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
  }
}

/** Bad input found while checking a request (Python's ValueError / TypeError): 400 with the message. */
export class BadInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadInput';
  }
}

/** The client stopped sending (a stalled or dropped body): the request ends without a reply. */
export class Gone extends Error {
  constructor() {
    super('client gone');
    this.name = 'Gone';
  }
}
