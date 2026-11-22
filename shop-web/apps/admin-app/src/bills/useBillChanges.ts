// The admin's changes to a ticket's bill (link, unlink, none of these, a typed final), as one hook. Each sends
// the link's version (null when the ticket has no link row). The bill that comes back goes in the cache; on
// success or refusal (409: changed on another device) every bill query is fetched again.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type Bill,
  type FinalIn,
  getGetInvoiceQueryKey,
  useLinkInvoice,
  useMarkNoInvoice,
  useTypeFinal,
  useUnlinkInvoice,
} from '@shop/api-client';
import { errorText } from '../lib/format';

export type Version = number | null;
export type FinalMoney = Omit<FinalIn, 'version'>;

export type BillChanges = {
  /** A change is on its way. */
  pending: boolean;
  /** Why the last change failed, or null. */
  error: string | null;
  clearError(): void;
  link(ticketId: number, invoiceNo: string, version: Version): Promise<Bill | null>;
  unlink(ticketId: number, version: Version): Promise<Bill | null>;
  none(ticketId: number, version: Version): Promise<Bill | null>;
  final(ticketId: number, money: FinalMoney, version: Version): Promise<Bill | null>;
};

export function useBillChanges(): BillChanges {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const settled = { mutation: { onSettled: () => client.invalidateQueries() } };
  const linkM = useLinkInvoice(settled);
  const unlinkM = useUnlinkInvoice(settled);
  const noneM = useMarkNoInvoice(settled);
  const finalM = useTypeFinal(settled);

  /** The bill the change sent back (also put in the cache), or null with `error` set. */
  async function run(send: Promise<{ data: unknown; status: number; headers: Headers }>): Promise<Bill | null> {
    setError(null);
    try {
      const reply = await send;
      const bill = reply.data as Bill;
      client.setQueryData(getGetInvoiceQueryKey(bill.key), reply);
      return bill;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  }

  const key = (ticketId: number): string => `t${ticketId}`;
  return {
    pending: linkM.isPending || unlinkM.isPending || noneM.isPending || finalM.isPending,
    error,
    clearError: () => setError(null),
    link: (id, invoice_no, version) => run(linkM.mutateAsync({ key: key(id), data: { invoice_no, version } })),
    unlink: (id, version) => run(unlinkM.mutateAsync({ key: key(id), data: { version } })),
    none: (id, version) => run(noneM.mutateAsync({ key: key(id), data: { version } })),
    final: (id, money, version) => run(finalM.mutateAsync({ key: key(id), data: { ...money, version } })),
  };
}
