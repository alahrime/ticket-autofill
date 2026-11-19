// What every route needs, kept on app.locals by createApp().
import type { Request } from 'express';
import type { Accounts } from '../accounts';
import type { Config } from '../config';
import type { TicketStore } from '../store';

export type Deps = { store: TicketStore; accounts: Accounts; config: Config };

export const depsOf = (req: Request): Deps => req.app.locals['deps'] as Deps;
