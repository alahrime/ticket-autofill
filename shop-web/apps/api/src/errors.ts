// Errors of the api layer. shop.py maps an unknown ticket id (KeyError) to 404.

/** No such record (Python's KeyError for an unknown ticket id). */
export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
  }
}
