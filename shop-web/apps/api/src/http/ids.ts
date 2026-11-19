// The :id check every /api/<thing>/:id route runs (shop.py's TICKET and USER patterns: 1 to 9 digits).
import type { RequestHandler } from 'express';

export const ID = /^[0-9]{1,9}$/;

/** On to the next route (in the end, the 404) unless :id is 1 to 9 digits; before any body is read. */
export const validId: RequestHandler = (req, _res, next) => {
  const id = req.params['id'];
  next(typeof id === 'string' && ID.test(id) ? undefined : 'route');
};
