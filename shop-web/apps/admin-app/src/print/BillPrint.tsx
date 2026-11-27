// The print page for one of our bills (/bills/<no>/print): the stored snapshot of its latest revision (or, with
// ?rev=N, of that earlier one) on letter paper, twice (two copies), then the browser's print window. It only
// shows the snapshot, never recomputes it, and never shows the revision: a reprint looks exactly like the original.
import { useEffect, useRef, useState } from 'react';
import { type BillSnapshot, type OwnBill, useGetOwnBill } from '@shop/api-client';
import { errorText } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useQueryState } from '../lib/useQueryState';
import * as text from './billText';
import { chunks, type HeaderText, headScale, LABOR_CPL, linesOf, PARTS_CPL, pageBudget, paginatePairs } from './paginate';
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

/** The header's text as printed (and what pageBudget estimates from). */
export function headerText(bill: BillSnapshot): HeaderText {
  const { shop, customer: c, vehicle: v } = bill;
  return {
    addressLine: shop.address.join(' | '),
    contactLine: `TEL ${printPhone(shop.phone)} HOURS ${shop.hours}`,
    customer: [`${c.first} ${c.last}`.trim().toUpperCase(), printPhone(c.phone)],
    vehicle: [`${v.year} ${v.make} ${v.model}`.trim(), v.plate, bill.mechanic, v.odometer, v.vin],
  };
}

/** The shop's logo (GET /shop-logo), shown once it has loaded; with none, the box stays as blank space. */
function Logo() {
  const [state, setState] = useState<'loading' | 'shown' | 'none'>('loading');
  return (
    <div className="logo">
      {state !== 'none' && (
        <img
          src="/shop-logo"
          alt=""
          style={state === 'loading' ? { visibility: 'hidden' } : undefined}
          onLoad={() => setState('shown')}
          onError={() => setState('none')}
        />
      )}
    </div>
  );
}

/** A list of label / value pairs: the label on the left, the value on the right. */
function Pairs({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="kv">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The header of every sheet; `scale` below 1 (see headScale) prints it smaller, all of it still there. */
function Header({ bill, page, pages, scale }: { bill: BillSnapshot; page: number; pages: number; scale: number }) {
  const date = printDate(bill.date);
  const h = headerText(bill);
  const [name = '', phone = ''] = h.customer;
  const [ymm = '', plate = '', mechanic = '', odometer = '', vin = ''] = h.vehicle;
  return (
    <header className="head" style={scale < 1 ? { zoom: scale } : undefined}>
      <div className="top">
        <div className="shop">
          <h1 className="title">{bill.shop.name}</h1>
          <p className="addr">{h.addressLine}</p>
          <p className="contact">
            <span className="k">TEL</span> <span>{printPhone(bill.shop.phone)}</span>
            <span className="sep" aria-hidden="true" />
            <span className="k">HOURS</span> <span>{bill.shop.hours}</span>
          </p>
        </div>
        <Logo />
      </div>
      <div className="info">
        <Pairs
          rows={[
            ['Name', name],
            ['Phone', phone],
          ]}
        />
        <div className="vehicle">
          <Pairs rows={[['Year / Make / Model', ymm]]} />
          <div className="vcols">
            <Pairs
              rows={[
                ['License', plate],
                ['Mechanic', mechanic],
              ]}
            />
            <Pairs
              rows={[
                ['Odometer', odometer],
                ['VIN', vin],
              ]}
            />
          </div>
        </div>
      </div>
      <div className="bar">
        <span>{`Date ${date}`}</span>
        <span>{`Schedule ${date}`}</span>
        <span className="invoice">{`INVOICE : ${bill.invoice_no}`}</span>
        <span className="page">{`Page ${page} of ${pages}`}</span>
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
    ['BALANCE DUE', a.balance, 'due'],
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

/** The last page's bottom: approval, notes and signature | the fine print | the totals. */
function Bottom({ bill }: { bill: BillSnapshot }) {
  return (
    <div className="bottom">
      <div className="stack">
        <div className="approval box">
          <p className="approval-cols">
            {text.APPROVAL_COLUMNS.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </p>
          <p className="small">{text.APPROVAL_NOTICE}</p>
        </div>
        <p className="notes">
          <b>{text.CHARGE}</b> <span>{text.PARTS_NEW}</span> <span>{text.STORAGE_NOTICE}</span>
        </p>
        <div className="sig">
          <p className="sign-title">{text.ACCEPTANCE_SIGNATURE}</p>
          <p className="small">{text.ACCEPTANCE_TERMS}</p>
          <p className="sign-line">
            <span className="sign-x">X</span>
          </p>
        </div>
      </div>
      <div className="fine">
        <p>
          {text.LIABILITY} <span className="initial">________</span>
        </p>
        <p>{text.AUTHORIZATION}</p>
      </div>
      <Totals bill={bill} />
    </div>
  );
}

type LaborRow = { desc: string; amount: number | null };
type PartRow = { desc: string; qty: number | null; price: number | null; total: number | null };
type Pair = { labor?: LaborRow; parts?: PartRow };

/** The numbers of a row, or blank (a continuation row of a description too long for one page has none). */
const num = (n: number | null | undefined): string => (n === null || n === undefined ? '' : fixed(n));

/**
 * The rows to print, labor line N beside parts line N. A description too long for a page goes over several
 * lines of its side, the amounts on the first.
 */
function pairsOf(bill: BillSnapshot, budget: number): Pair[] {
  const labor: LaborRow[] = bill.labor.flatMap((l) =>
    chunks(l.desc, budget * LABOR_CPL).map((desc, i) => ({ desc, amount: i === 0 ? l.amount : null })),
  );
  const parts: PartRow[] = bill.parts.flatMap((p) =>
    chunks(p.desc, budget * PARTS_CPL).map((desc, i) => ({
      desc,
      qty: i === 0 ? p.qty : null,
      price: i === 0 ? p.price : null,
      total: i === 0 ? p.total : null,
    })),
  );
  return Array.from({ length: Math.max(labor.length, parts.length) }, (_, i) => ({ labor: labor[i], parts: parts[i] }));
}

/** Printed lines a pair takes: its taller side. */
const weightOf = (p: Pair): number =>
  Math.max(p.labor ? linesOf(p.labor.desc, LABOR_CPL) : 1, p.parts ? linesOf(p.parts.desc, PARTS_CPL) : 1);

type SheetProps = { bill: BillSnapshot; page: number; pages: number; pairs: Pair[]; blank: number; scale: number };

function Sheet({ bill, page, pages, pairs, blank, scale }: SheetProps) {
  const last = page === pages;
  return (
    <article className="sheet">
      <Header bill={bill} page={page} pages={pages} scale={scale} />
      <div className="lines-box">
        <table className="lines">
          <colgroup>
            <col />
            <col className="w-price" />
            <col className="w-pdesc" />
            <col className="w-qty" />
            <col className="w-price" />
            <col className="w-price" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">REMARKS AND LABOR DESCRIPTIONS</th>
              <th scope="col" className="num split">
                PRICE
              </th>
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
            {pairs.map(({ labor: l, parts: p }, i) => (
              <tr key={i}>
                <td className="ld">{l?.desc ?? ''}</td>
                <td className="lp num split">{num(l?.amount)}</td>
                <td className="pd">{p?.desc ?? ''}</td>
                <td className="pq num">{num(p?.qty)}</td>
                <td className="pp num">{num(p?.price)}</td>
                <td className="pt num">{num(p?.total)}</td>
              </tr>
            ))}
            {Array.from({ length: blank }, (_, i) => (
              <tr key={`blank${i}`} className="blank" aria-hidden="true">
                <td />
                <td className="split" />
                <td />
                <td />
                <td />
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {last ? <Bottom bill={bill} /> : <p className="more">Continued on the next page</p>}
    </article>
  );
}

function Copy({ bill, n }: { bill: BillSnapshot; n: number }) {
  const h = headerText(bill);
  const scale = headScale(bill.shop.name, h);
  const budget = pageBudget(bill.shop.name, h, scale);
  const pairs = pairsOf(bill, budget);
  const weights = pairs.map(weightOf);
  const pages = paginatePairs(weights, budget);
  return (
    <section className="copy" aria-label={`Bill copy ${n} of ${COPIES}`}>
      {pages.map(([from, to], i) => {
        const used = weights.slice(from, to).reduce((t, w) => t + w, 0);
        return (
          <Sheet
            key={i}
            bill={bill}
            page={i + 1}
            pages={pages.length}
            pairs={pairs.slice(from, to)}
            blank={Math.max(0, budget - used)}
            scale={scale}
          />
        );
      })}
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
