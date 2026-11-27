// The print page for one of our bills (/bills/<no>/print): the stored snapshot of its latest revision (or, with
// ?rev=N, of that earlier one) on letter paper, twice (two copies), then the browser's print window. It only
// shows the snapshot, never recomputes it, and never shows the revision: a reprint looks exactly like the original.
import { useEffect, useRef } from 'react';
import { type BillSnapshot, type OwnBill, useGetOwnBill } from '@shop/api-client';
import { errorText } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useQueryState } from '../lib/useQueryState';
import * as text from './billText';
import { chunks, type HeaderText, LABOR_CPL, linesOf, PARTS_CPL, pageBudget, paginate } from './paginate';
import { printPhone } from './printPhone';
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

/** The header's text as the new layout prints it (what pageBudget estimates from). */
export function headerText(bill: BillSnapshot): HeaderText {
  const { shop, customer: c, vehicle: v } = bill;
  return {
    addressLine: shop.address.join(' | '),
    contactLine: `TEL ${printPhone(shop.phone)} HOURS ${shop.hours}`,
    customer: [`${c.first} ${c.last}`.trim().toUpperCase(), printPhone(c.phone)],
    vehicle: [`${v.year} ${v.make} ${v.model}`.trim(), v.plate, bill.mechanic, v.odometer, v.vin],
  };
}

/** The header's three columns of lines: the customer, the shop and the vehicle (the mechanic last, no label). */
function headerColumns(bill: BillSnapshot): [string[], string[], string[]] {
  const { shop, customer: c, vehicle: v } = bill;
  return [
    [`${c.first} ${c.last}`.trim().toUpperCase(), c.phone],
    [...shop.address, shop.phone, shop.hours],
    [
      `Year Make. ${v.year} ${v.make} ${v.model}`,
      `License ${v.plate}`,
      `MLG in/out ${v.odometer} / ${v.odometer}`,
      `Vin ${v.vin}`,
      bill.mechanic,
    ],
  ];
}

function Header({ bill, page }: { bill: BillSnapshot; page: number }) {
  const date = printDate(bill.date);
  const [who, shop, car] = headerColumns(bill);
  return (
    <header className="head">
      <h1 className="title">{bill.shop.name}</h1>
      <div className="head-cols">
        <div className="who">
          {who.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <div className="shop">
          {shop.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <div className="car">
          {car.map((line, i) => (
            <p key={i} className={i === car.length - 1 ? 'mechanic' : undefined}>
              {line}
            </p>
          ))}
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

type LaborRow = { desc: string; amount: number | null };
type PartRow = { desc: string; qty: number | null; price: number | null; total: number | null };

/** The numbers of a row, or blank (a continuation row of a description too long for one page has none). */
const num = (n: number | null): string => (n === null ? '' : fixed(n));

/** The rows to print: a description too long for a page goes over several rows, the amounts on the first. */
function rowsOf(bill: BillSnapshot, budget: number): { labor: LaborRow[]; parts: PartRow[] } {
  return {
    labor: bill.labor.flatMap((l) => chunks(l.desc, budget * LABOR_CPL).map((desc, i) => ({ desc, amount: i === 0 ? l.amount : null }))),
    parts: bill.parts.flatMap((p) =>
      chunks(p.desc, budget * PARTS_CPL).map((desc, i) => ({
        desc,
        qty: i === 0 ? p.qty : null,
        price: i === 0 ? p.price : null,
        total: i === 0 ? p.total : null,
      })),
    ),
  };
}

type SheetProps = {
  bill: BillSnapshot;
  page: number;
  last: boolean;
  labor: LaborRow[];
  parts: PartRow[];
};

function Sheet({ bill, page, last, labor, parts }: SheetProps) {
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
                <td className="num">{num(l.amount)}</td>
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
                <td className="num">{num(p.qty)}</td>
                <td className="num">{num(p.price)}</td>
                <td className="num">{num(p.total)}</td>
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
  const budget = pageBudget(bill.shop.name, headerText(bill));
  const rows = rowsOf(bill, budget);
  const pages = paginate(
    rows.labor.map((r) => linesOf(r.desc, LABOR_CPL)),
    rows.parts.map((r) => linesOf(r.desc, PARTS_CPL)),
    budget,
  );
  return (
    <section className="copy" aria-label={`Bill copy ${n} of ${COPIES}`}>
      {pages.map((range, i) => (
        <Sheet
          key={i}
          bill={bill}
          page={i + 1}
          last={i === pages.length - 1}
          labor={rows.labor.slice(...range.labor)}
          parts={rows.parts.slice(...range.parts)}
        />
      ))}
    </section>
  );
}

/** ?rev=N: an earlier revision, as stored (Bill history's View / Print); else the latest. */
const REV = /^[1-9]\d{0,5}$/;

export function BillPrint({ no }: { no: string }) {
  const [query] = useQueryState();
  const asked = query.get('rev') ?? '';
  const rev = REV.test(asked) ? asked : undefined;
  useDocumentTitle(rev ? `Bill ${no}, revision ${rev}` : `Bill ${no}`); // the tab only: the paper never says
  const noprint = query.get('noprint') === '1';
  const q = useGetOwnBill(no, rev ? { rev } : undefined, { query: { retry: false, refetchOnWindowFocus: false } });
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

  if (error && !data) {
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
