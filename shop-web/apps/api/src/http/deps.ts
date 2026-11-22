// What every route needs, kept on app.locals by createApp().
import type { Request } from 'express';
import type { Accounts } from '../accounts';
import type { Config } from '../config';
import type { History } from '../history/bills';
import type { LinkStore } from '../history/links';
import type { Nightly } from '../nightly';
import type { TicketStore } from '../store';

export type Deps = {
  store: TicketStore;
  accounts: Accounts;
  config: Config;
  links: LinkStore;
  history: History;
  nightly: Nightly;
};

export const depsOf = (req: Request): Deps => req.app.locals['deps'] as Deps;
