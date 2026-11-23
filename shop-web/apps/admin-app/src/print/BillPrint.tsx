// The print page for one of our bills (/bills/<no>/print): the stored snapshot of its latest revision on letter
// paper, twice (two copies), then the browser's print window. It only shows the snapshot, never recomputes it,
// and never shows the revision: a reprint looks exactly like the original.
import { useEffect, useRef } from 'react';
import { type BillSnapshot, type OwnBill, useGetOwnBill } from '@shop/api-client';
import { errorText } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useQueryState } from '../lib/useQueryState';
import * as text from './billText';
import { paginate, ROWS_PER_PAGE } from './paginate';
import './print.css';

const COPIES = 2;

/** 2 decimals, always: 5 -> 5.00. */
const fixed = (n: number): string => n.toFixed(2);

/** 2026-11-23 -> 11/23/26. */
export function printDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : iso;
}

/** 14:22 -> 02:22 pm. */
export function printTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${String(h % 12 || 12).padStart(2, '0')}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

function Header({ bill, page }: { bill: BillSnapshot; page: number }) {
  const { shop, customer: c, vehicle: v } = bill;
  const date = printDate(bill.date);
  return (
    <header className="head">
      <h1 className="title">{shop.name}</h1>
      <div className="head-cols">
        <div className="who">
          <p>{`${c.first} ${c.last}`.trim().toUpperCase()}</p>
          <p>{c.phone}</p>
        </div>
        <div className="shop">
          {shop.address.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          <p>{shop.phone}</p>
          <p>{shop.hours}</p>
        </div>
        <div className="car">
          <p>{`Year Make. ${v.year} ${v.make} ${v.model}`}</p>
          <p>{`License ${v.plate}`}</p>
          <p>{`MLG in/out ${v.odometer} / ${v.odometer}`}</p>
          <p>{`Vin ${v.vin}`}</p>
          <p className="mechanic">{bill.mechanic}</p>
        </div>
      </div>
      <div className="numbers">
        <span>{`Date ${date}`}</span>
        <span>{`Schedule ${date}`}</span>
        <span className="invoice">{`INVOICE : ${bill.invoice_no}`}</span>
        <span>{printTime(bill.time)}</span>
        <span>{`Page ${page}`}</span>
      </div>
    </header>
  );
}

function Totals({ bill }: { bill: BillSnapshot }) {
  const a = bill.amounts;
  const subTotal = Math.round((a.parts + a.labor + a.supplies) * 100) / 100;
  const rows: Array<[string, number, string?]> = [
    ['Parts & Lubricants', a.parts],
    ['Labor', a.labor],
    ['Sublet', 0],
    ['HAZ. DISPOSAL', 0],
    ['SHOP SUPPLY', a.supplies],
    ['Gasoline', 0],
    ['Sub Total', subTotal],
    ['Sales Tax', a.tax],
    ['Deposit', a.deposit, 'band'],
    ['Disc. Applied', 0, 'band'],
    ['TOTAL', a.total, 'strong'],
    ['BALANCE DUE', a.balance, 'strong'],
  ];
  return (
    <table className="totals">
      <tbody>
        {rows.map(([label, amount, cls]) => (
          <tr key={label} className={cls}>
            <th scope="row">{label}</th>
            <td>{fixed(amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Notices() {
  return (
    <div className="notices">
      <div className="approval box">
        <p className="approval-cols">
          {text.APPROVAL_COLUMNS.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </p>
        <p className="small">{text.APPROVAL_NOTICE}</p>
      </div>
      <p className="charge">{text.CHARGE}</p>
      <p className="box small">{text.PARTS_NEW}</p>
      <p className="box small">{text.STORAGE_NOTICE}</p>
      <div className="signature">
        <p className="sign-line">X ........................................</p>
        <p className="sign-title">{text.ACCEPTANCE_SIGNATURE}</p>
        <p className="small">{text.ACCEPTANCE_TERMS}</p>
      </div>
      <p className="box tiny">
        {text.LIABILITY} <span className="initial">________</span>
      </p>
      <p className="box tiny">{text.AUTHORIZATION}</p>
    </div>
  );
}

function Sheet({ bill, page, last, range }: { bill: BillSnapshot; page: number; last: boolean; range: ReturnType<typeof paginate>[number] }) {
  const labor = bill.labor.slice(...range.labor);
  const parts = bill.parts.slice(...range.parts);
  return (
    <article className="sheet">
      <Header bill={bill} page={page} />
      <div className="lines">
        <table className="labor">
          <thead>
            <tr>
              <th scope="col">REMARKS AND LABOR DESCRIPTIONS</th>
              <th scope="col" className="num">
                PRICE
              </th>
            </tr>
          </thead>
          <tbody>
            {labor.map((l, i) => (
              <tr key={i}>
                <td>{l.desc}</td>
                <td className="num">{fixed(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="parts">
          <thead>
            <tr>
              <th scope="col">PARTS &amp; LUBRICANTS</th>
              <th scope="col" className="num">
                QTY
              </th>
              <th scope="col" className="num">
                PRICE
              </th>
              <th scope="col" className="num">
                TOTAL
              </th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p, i) => (
              <tr key={i}>
                <td>{p.desc}</td>
                <td className="num">{fixed(p.qty)}</td>
                <td className="num">{fixed(p.price)}</td>
                <td className="num">{fixed(p.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {last ? (
        <div className="bottom">
          <Notices />
          <Totals bill={bill} />
        </div>
      ) : (
        <p className="more">Continued on the next page</p>
      )}
    </article>
  );
}

function Copy({ bill, n }: { bill: BillSnapshot; n: number }) {
  const pages = paginate(bill.labor.length, bill.parts.length, ROWS_PER_PAGE);
  return (
    <section className="copy" aria-label={`Bill copy ${n} of ${COPIES}`}>
      {pages.map((range, i) => (
        <Sheet key={i} bill={bill} page={i + 1} last={i === pages.length - 1} range={range} />
      ))}
    </section>
  );
}

export function BillPrint({ no }: { no: string }) {
  useDocumentTitle(`Bill ${no}`);
  const [query] = useQueryState();
  const noprint = query.get('noprint') === '1';
  const q = useGetOwnBill(no, { query: { retry: false, refetchOnWindowFocus: false } });
  const { error } = q;
  const data = q.data?.data as OwnBill | undefined;
  const printed = useRef(false);
  const loaded = data !== undefined;

  // Once the bill shows, open the print window once (not again for a refetch or a re-render).
  useEffect(() => {
    if (!loaded || noprint || printed.current) return;
    const t = setTimeout(() => {
      printed.current = true;
      window.print();
    }, 0);
    return () => clearTimeout(t);
  }, [loaded, noprint]);

  if (error) {
    return (
      <main className="bill-print">
        <h1 className="print-heading">{`Bill ${no}`}</h1>
        <p role="alert" className="print-message">
          {`Bill ${no} could not be loaded. ${errorText(error)}`}
        </p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="bill-print">
        <h1 className="print-heading">{`Bill ${no}`}</h1>
        <p role="status" className="print-message">
          Loading bill {no}...
        </p>
      </main>
    );
  }
  return (
    <main className="bill-print">
      {Array.from({ length: COPIES }, (_, i) => (
        <Copy key={i} bill={data.bill} n={i + 1} />
      ))}
    </main>
  );
}
