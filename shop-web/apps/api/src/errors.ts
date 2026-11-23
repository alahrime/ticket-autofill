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

/** Our own bills: nothing is numbered until the first invoice number is confirmed (428). */
export class NotConfirmed extends Error {
  constructor(message = 'confirm the first invoice number first') {
    super(message);
    this.name = 'NotConfirmed';
  }
}

/** The ticket already has our bill: 409 with that bill's number, so the page can offer a reprint. */
export class AlreadyBilled extends Error {
  constructor(readonly invoice_no: string) {
    super(`already billed as #${invoice_no}`);
    this.name = 'AlreadyBilled';
  }
}
