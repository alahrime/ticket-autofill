// The #needs section at the top of /bills: filled tickets with no bill tied to them yet, each with the InvoMax
// bills that might be theirs (same plate or phone, near the day it was filled). Link one, say None of these, or
// type any bill number: the list leaves out bills other tickets have and pairs unlinked before, so the number
// box is how the admin overrides it.
import { useEffect, useId, useState } from 'react';
import { type Candidate, type ListNeedsBill200, type NeedsBill as Ticket, useListNeedsBill } from '@shop/api-client';
import { errorText, money } from '../lib/format';
import { LinkByNumber } from './LinkByNumber';
import { type BillChanges, useBillChanges } from './useBillChanges';

type Props = {
  /** Opens a ticket's row in the detail (t<id>). */
  onOpen?(key: string): void;
};

const WHY: Record<Candidate['why'], string> = { plate: 'same plate', phone: 'same phone' };

function TicketCard({
  t,
  changes,
  onDone,
  onOpen,
}: {
  t: Ticket;
  changes: BillChanges;
  onDone(message: string): void;
  onOpen?(key: string): void;
}) {
  const id = useId();
  const name = `Ticket #${t.ticket_id}`;
  const link = async (no: string): Promise<boolean> => {
    const b = await changes.link(t.ticket_id, no, null);
    if (b) onDone(`Linked ticket #${t.ticket_id} to bill ${no}`);
    return b !== null;
  };

  return (
    <li>
      <div className="card" role="group" aria-labelledby={id}>
        <h3 id={id}>
          {name} — {t.name}
        </h3>
        <p className="meta">
          {[t.vehicle, t.plate, `filled ${t.filled}`].filter(Boolean).join(' · ')} · our subtotal {money(t.subtotal)}
        </p>
        {t.candidates.length ? (
          <ul className="candidates">
            {t.candidates.map((c) => (
              <li key={c.invoice_no}>
                <span>
                  Bill #{c.invoice_no} · {c.date} · {c.name} · {c.plate} · {money(c.total)} · {WHY[c.why]}
                </span>
                <button
                  type="button"
                  className="primary"
                  aria-label={`Link bill ${c.invoice_no} to ticket #${t.ticket_id}`}
                  disabled={changes.pending}
                  onClick={() => void link(c.invoice_no)}
                >
                  Link
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No likely bills in InvoMax.</p>
        )}
        <div className="card-actions">
          <button
            type="button"
            disabled={changes.pending}
            onClick={() =>
              void changes.none(t.ticket_id, null).then((b) => b && onDone(`Ticket #${t.ticket_id}: marked as having no InvoMax bill`))
            }
          >
            None of these
          </button>
          {onOpen && (
            <button type="button" className="link" onClick={() => onOpen(`t${t.ticket_id}`)}>
              Open ticket #{t.ticket_id}
            </button>
          )}
        </div>
        <LinkByNumber disabled={changes.pending} onLink={link} />
      </div>
    </li>
  );
}

export function NeedsBill({ onOpen }: Props) {
  const headingId = useId();
  const q = useListNeedsBill();
  const changes = useBillChanges();
  const [done, setDone] = useState('');
  const tickets = (q.data?.data as ListNeedsBill200 | undefined)?.tickets;
  const loaded = tickets !== undefined;

  useEffect(() => {
    // the board's "N tickets need a bill" links to /bills#needs: show it once the list is in
    if (loaded && window.location.hash === '#needs') document.getElementById('needs')?.scrollIntoView?.();
  }, [loaded]);

  return (
    <section id="needs" className="needs" aria-labelledby={headingId}>
      <h2 id={headingId}>Tickets that need their bill{tickets?.length ? ` (${tickets.length})` : ''}</h2>
      <p role="status" className="notice">
        {done}
      </p>
      {changes.error && (
        <p className="error" role="alert">
          {changes.error}
        </p>
      )}
      {q.isPending && <p>Loading…</p>}
      {q.isError && (
        <p className="error" role="alert">
          {errorText(q.error)}
        </p>
      )}
      {tickets && !tickets.length && <p className="empty">Every filled ticket has its bill.</p>}
      {tickets && tickets.length > 0 && (
        <ul className="cards">
          {tickets.map((t) => (
            <TicketCard key={t.ticket_id} t={t} changes={changes} onDone={setDone} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}
