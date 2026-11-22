// One bill's two sides: our ticket (what the mechanic wrote) and InvoMax's bill (what the customer paid), each
// with its lines and totals, how they were tied together, and the admin's changes for a ticket of ours.
import { useEffect, useId, useRef, useState } from 'react';
import { type Bill, type BillAfter, type BillBefore, type BillLink, useGetInvoice } from '@shop/api-client';
import { errorText, money, phone } from '../lib/format';
import { LinkByNumber } from './LinkByNumber';
import { TypeFinalForm } from './TypeFinalForm';
import { useBillChanges } from './useBillChanges';

type Props = {
  billKey: string;
  /** A change gave the row a new key (a link makes t<id> into im<no>, an unlink the other way). */
  onKeyChange?(key: string): void;
  onClose?(): void;
  /** Move focus to the heading once it shows (it was opened from the table). */
  focus?: boolean;
};

const title = (key: string): string => (key.startsWith('im') ? `InvoMax bill #${key.slice(2)}` : `Ticket #${key.slice(1)}`);

function linkedHow(link: BillLink): string {
  const on = link.linked_at.slice(0, 10);
  if (link.source === 'none') return `Marked as having no InvoMax bill on ${on}.`;
  if (link.source === 'typed') return `Final bill typed by hand on ${on}.`;
  return link.linked_by === 'auto' ? `Linked automatically on ${on}.` : `Linked by the desk on ${on}.`;
}

function Totals({ rows }: { rows: Array<[string, number]> }) {
  return (
    <dl className="totals">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{money(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

const cell = (v: number | null): string => (v === null ? '' : money(v));

function OurTicket({ before }: { before: BillBefore | null }) {
  const id = useId();
  return (
    <section className="side" aria-labelledby={id}>
      <h3 id={id}>Our ticket</h3>
      {!before ? (
        <p className="empty">No ticket</p>
      ) : (
        <>
          <p className="side-ref">Ticket #{before.ticket_id}</p>
          {before.lines.length ? (
            <table className="lines">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="num">
                    Qty
                  </th>
                  <th scope="col" className="num">
                    Parts
                  </th>
                  <th scope="col" className="num">
                    Labor
                  </th>
                </tr>
              </thead>
              <tbody>
                {before.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.desc}</td>
                    <td className="num">{l.qty}</td>
                    <td className="num">{cell(l.price)}</td>
                    <td className="num">{cell(l.labor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No lines</p>
          )}
          <Totals
            rows={[
              ['Parts', before.parts],
              ['Labor', before.labor],
              ['Subtotal', before.subtotal],
            ]}
          />
        </>
      )}
    </section>
  );
}

function InvoMaxBill({ after }: { after: BillAfter | null }) {
  const id = useId();
  return (
    <section className="side" aria-labelledby={id}>
      <h3 id={id}>InvoMax bill</h3>
      {!after ? (
        <p className="empty">No InvoMax bill yet</p>
      ) : (
        <>
          <p className="side-ref">
            {after.invoice_no ? `Bill #${after.invoice_no}` : 'No bill number'}, {after.date}
            {after.source === 'typed' && ' (typed by hand)'}
          </p>
          {after.gone && <p className="warn">Removed from InvoMax</p>}
          {after.lines.length ? (
            <table className="lines">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="num">
                    Qty
                  </th>
                  <th scope="col" className="num">
                    Unit
                  </th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {after.lines.map((l, i) => (
                  <tr key={`${l.code}-${i}`}>
                    <td className="code">{l.code}</td>
                    <td>{l.description}</td>
                    <td className="num">{l.qty}</td>
                    <td className="num">{money(l.unit)}</td>
                    <td className="num">{money(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">No lines</p>
          )}
          <Totals
            rows={[
              ['Parts', after.parts],
              ['Labor', after.labor],
              ['Supplies', after.supplies],
              ...(after.discount ? [['Discount', after.discount] as [string, number]] : []),
              ['Tax', after.tax],
              ['Total', after.total],
              ...(after.deposit ? [['Deposits', after.deposit] as [string, number]] : []),
              ['Balance', after.balance],
            ]}
          />
        </>
      )}
    </section>
  );
}

/** Unlink, Link by bill number and Type the final bill, for the ticket of ours on this bill. */
function Changes({ bill, onKeyChange }: { bill: Bill & { before: BillBefore }; onKeyChange?(key: string): void }) {
  const changes = useBillChanges();
  const [typing, setTyping] = useState(false);
  const formId = useId();
  const ticket = bill.before.ticket_id;
  const version = bill.link?.version ?? null;
  const linked = bill.link?.source === 'invomax';

  const done = (b: Bill | null): boolean => {
    if (b && b.key !== bill.key) onKeyChange?.(b.key);
    return b !== null;
  };

  return (
    <div className="changes">
      {changes.error && (
        <p className="error" role="alert">
          {changes.error}
        </p>
      )}
      {bill.link && (
        <button type="button" disabled={changes.pending} onClick={() => void changes.unlink(ticket, version).then(done)}>
          Unlink
        </button>
      )}
      {!linked && (
        <>
          <LinkByNumber disabled={changes.pending} onLink={async (no) => done(await changes.link(ticket, no, version))} />
          <button type="button" aria-expanded={typing} aria-controls={formId} onClick={() => setTyping((t) => !t)}>
            Type the final bill
          </button>
          {typing && (
            <TypeFinalForm
              id={formId}
              disabled={changes.pending}
              onCancel={() => setTyping(false)}
              onSave={async (money) => {
                const ok = done(await changes.final(ticket, money, version));
                if (ok) setTyping(false);
                return ok;
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

export function BillDetail({ billKey, onKeyChange, onClose, focus = false }: Props) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const q = useGetInvoice(billKey);
  const bill = q.data?.data as Bill | undefined;
  const shown = Boolean(bill);

  useEffect(() => {
    if (!focus || !shown || !heading.current) return;
    heading.current.focus();
    heading.current.scrollIntoView?.({ block: 'nearest' });
  }, [focus, shown, billKey]);

  return (
    <section className="detail" aria-labelledby={headingId}>
      <div className="detail-head">
        <h2 id={headingId} ref={heading} tabIndex={-1}>
          {title(billKey)}
        </h2>
        {onClose && (
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      {q.isPending && <p>Loading…</p>}
      {q.isError && (
        <p className="error" role="alert">
          {errorText(q.error)}
        </p>
      )}
      {bill && (
        <>
          <p className="customer">
            {[bill.customer.name, phone(bill.customer.phone), bill.customer.vehicle, bill.customer.plate].filter(Boolean).join(' · ')}
          </p>
          {bill.link && <p className="linked">{linkedHow(bill.link)}</p>}
          {bill.difference !== null && bill.difference !== 0 && (
            <p className="warn">
              Our subtotal differs by {money(Math.abs(bill.difference))} ({bill.difference > 0 ? 'ours is more' : 'ours is less'}).
            </p>
          )}
          <div className="sides">
            <OurTicket before={bill.before} />
            <InvoMaxBill after={bill.after} />
          </div>
          {bill.before && <Changes bill={{ ...bill, before: bill.before }} onKeyChange={onKeyChange} />}
        </>
      )}
    </section>
  );
}
