# Own billing: our app prints the bill (replaces InvoMax) — design

**Date:** 2026-11-23. **Status:** approved by the owner, 2026-11-23.

## Why
InvoMax's price is going up, and the owner will pay for it 1–2 more months at most (from 2026-11-21). Today the admin enters the whole invoice in our app (phone or desk), then staff **retype it into InvoMax** to get supplies, tax, an invoice number and the printout. The owner won't retype anything. Instead, the data entered on the phone should go straight onto a printed bill made by our app.

Success: the admin enters a job, presses one button, and two letter-size copies come out at the desk. They look and read like today's InvoMax bill, with correct supplies, tax and total, and the bill is saved in Bill history. InvoMax is no longer used for new bills.

## Goals
- Work out supplies, tax, total and balance due from the ticket's lines and deposits.
- Give each bill the next invoice number, continuing after InvoMax's last one.
- Print a page that copies InvoMax's layout and wording (2 copies), from the desk PC's browser.
- Save every bill, show it in Bill history, and reprint it any time.
- A printed bill with a mistake can be fixed and reprinted **under the same number**, keeping what it was before.

## Non-goals
- **Payments.** The shop's own terminal and register handle cash and card. The bill doesn't record payment, except the deposits the admin already enters on the ticket.
- No hours column, engine, used-parts marking or customer address (owner, 2026-11-23).
- No tax-free bills: tax is always charged.
- No discount box (owner, 2026-11-23). A price cut is made by lowering line prices. "Disc. Applied" always prints 0.00.
- No typing into InvoMax and no side-by-side running (that would mean typing into InvoMax).
- No PDF and no printing from the phone straight to the printer (approach C below; maybe later).
- No cloud, no CDN; everything is served by the shop server on this PC.

## Anti-goals (a failure even if it works)
- Two bills with the same invoice number, or a number InvoMax already used.
- Tax or supplies that differ from InvoMax's rules by a cent.
- A printed bill whose numbers differ from what's stored.
- A fix that silently overwrites what the customer signed.

## Constraints
- It needs the TypeScript server (`shop-web/apps/api`); `shop.py` won't get this. The switch to the TS server comes first.
- Money is integer cents; amounts are rounded half-up to the cent, as InvoMax does (checked on 4 real bills, 2026-11-23).
- No customer data in git, tests or logs. Use made-up values (JANE DOE, (555)010-0000, XKS-4827, invoice numbers 9000001+ in tests).
- Never write in `C:\hunni` or InvoMax's folder.
- The house style holds: React function components and hooks; Express + OpenAPI + Orval; Jest and Playwright; two reviewers per task.

## The rules (owner-confirmed)
For one bill, in cents:
- **Parts** = Σ over lines of qty × part price (the existing `totals()` in `@shop/domain`).
- **Labor** = Σ of the lines' labor charges.
- **Supplies** = 5% of (parts + labor), at most $20.00, rounded half-up.
- **Tax** = 6% of (parts + supplies), rounded half-up. Labor isn't taxed. Always charged.
- **Total** = parts + labor + supplies + tax.
- **Deposit** = Σ of the ticket's deposits. **Balance due** = total − deposit.
- Sublet, Haz. Disposal, Gasoline and Disc. Applied always print 0.00.

Checked against #8003164, #8003163, #8003166 and #8003129 (all match).

**Discount (settled by the owner, 2026-11-23): none.** In the imported history (352 bills since 2022 with "Disc. Applied" above 0), InvoMax never took it off the total or the balance due; it only lowered supplies. So price cuts go into the line prices.

## The printed bill
One letter-size page per copy, copying InvoMax's printout (photos seen 2026-11-23; not kept in the repo). From top to bottom:

```
                    JAPANESE AUTO SERVICE
JANE DOE                 3413 WILSON BLVD           Year Make.  2015 Make Model
(555)010-0000            ARLINGTON, VA 22201        License     XKS-4827
                         (703)522-3100              MLG in/out  123456 / 123456
                         M-F 8.00 AM TO 7.00        Vin         ...
                                                    <mechanic>
Date 11/23/26   Schedule 11/23/26   INVOICE : 8003168      02:22 pm   Page 1
REMARKS AND LABOR DESCRIPTIONS   PRICE | PARTS & LUBRICANTS      QTY  PRICE  TOTAL
DIAGNOSTIC                       55.00 | BRAKE PADS             1.00 100.00 100.00
Remove & Install: BRAKE PADS 50.00 |
...
[oral approval box] [All parts new... / Labor, Sublet] [Parts & Lubricants]
                    [storage notice]                   [HAZ. DISPOSAL, SHOP SUPPLY, Gasoline,
X ........ ACCEPTANCE SIGNATURE                          Sub Total, Sales Tax, Deposit,
[liability box, initial here] [authorization / warranty]  Disc. Applied, TOTAL, BALANCE DUE]
```

- **Header:** the shop's name, address, phone and hours come from settings, not code. Customer: name and phone only. Vehicle: year + make + model, plate, odometer printed as in / out (the same number: owner rule), VIN, mechanic.
- **Date / Schedule:** both the bill's date. The time is when it was first approved.
- **Lines:** a line with a labor charge prints on the left. A line that also has a part prints its labor as `Remove & Install: <desc>`, the way InvoMax prints Installation Charge. A labor-only line prints its description. A part prints on the right with qty, price each and line total. There is no HRS column.
- **Fixed wording**, word for word from the photos: the oral-approval box, "All Parts Are New Unless Shown As (U) Used", the storage notice, "ACCEPTANCE SIGNATURE / I accept the charges and terms of this agreement.", the liability box with "intial here ____", and the authorization/warranty paragraph (90 days / 4000 miles). Keep this text in one place, so it can be changed without touching the layout.
- **The fixed wording, transcribed from the photos.** Spacing and the two typos ("STRORAGE", "intial") are corrected; this is a call made in the design, which the owner can reverse.
  - Approval box heading: `DATE  TIME  PHONE  APPROVED  AMOUNT`; under its line: "I acknowledge notice and oral approval of an increase in the original estimated price". Below the box: `CHARGE`.
  - Box next to Labor / Sublet: "All Parts Are New Unless Shown As (U) Used".
  - Storage box: "DAILY STORAGE 24HRS AFTER JOB DONE $65.00. BY SIGNING I WILL NOT DISPUTE THE CHARGES."
  - Signature: `X ........` then "A C C E P T A N C E   S I G N A T U R E" and "I accept the charges and terms of this agreement."
  - Liability box: "Under no circumstances shall J.A.S. be liable for any damages resulting from the use or inability to use the vehicle. All parts are new unless specified as (u) used. Removed parts will be disposed of unless I initial here ________"
  - Authorization box: "I authorize the above repairs and materials. J.A.S. may operate vehicles for testing at my risk. J.A.S. is not responsible for loss or damage to vehicle or items left in it. I agree to pay reasonable storage fees on car if left more than 1 working day. I understand that labor is warranted for 90 days or 4000 miles. I agree that all warranty shall be void if corrective action is performed elsewhere. If J.A.S. is unable to repair warranted work performed under this invoice after undertaking reasonable efforts to do so, in its sole discretion, refund the original amount charged for labor under this invoice. My acceptance of such refund shall waive all warranty claims hereunder. In no event shall J.A.S. be responsible for indirect, consequential, or punitive damages."
- **Owner on the look (2026-11-23):** not too different from the photos, but the priority is carrying **all the same information**. The design of the bill gets iterated later.
- **Look:** title in a bold serif (Times-like); everything else in a plain sans (Arial-like). The column headings and the Deposit / Disc. Applied rows sit on a light grey band, and the boxes have thin black rules, as in the sketch above. The photos stay with the owner (customer data); the first print on the trial copy is compared against a real InvoMax bill by the owner.
- **More lines than fit:** continue on page 2 with the header repeated; the totals go on the last page; "Page N".
- **Two copies:** the print page holds the bill twice (a page break between), so a single Print prints both.

## How it works (approach A, picked by the owner)
- **Approve & print** on the admin's invoice entry (`web/admin.html`), for a ticket with a mechanic and at least one line:
  - saves the ticket and moves it to `filled`;
  - creates the bill: takes the next number, works out the totals and **stores a snapshot** of everything printed (customer, vehicle, lines, amounts, date and time);
  - opens the print page (`/bills/<no>/print` in the React admin app), which calls the browser's print window once it has loaded.
- The print page **only shows the stored snapshot**; it never recomputes from the ticket.
- **Invoice numbers:** a counter in tickets.db, taken inside the same write transaction as the bill. The next number is the highest of (our last number, the highest InvoMax number in `invomax.db`) + 1. It refuses to issue any number InvoMax has used. One outlier InvoMax number (around 48888884) and other odd numbers must not drive the counter: use only InvoMax numbers in the current 7-digit 800xxxx run (the builder settles the exact rule from the import data and records it).
- **Fixing a bill:** the admin presses **Fix bill** on it. The ticket opens for editing again, and **Save & reprint** stores a new revision of the snapshot under the **same number**, then opens the print page. Every earlier revision is kept, with who changed it and when. Bill history shows the latest and lists the earlier ones. **The printed reprint looks exactly like the original** (owner, 2026-11-23): same date and time, no "revised" mark on paper. Only the app marks it: Bill history shows "Revised" with the date and who changed it.
- **Reprint:** from Bill history, any time; it prints the latest revision.
- **Bill history:** our bills join InvoMax's in the existing `/bills` page and `invoice_finals` (a new source, `ours`). The nightly auto-linking skips tickets that have our own bill.
- **The first number on go-live day** (call made in the design): bills InvoMax made that day aren't in `invomax.db` until the next import. So the first Approve & print runs an InvoMax import first, then shows "First invoice number: N", with N the highest InvoMax number + 1. The admin confirms N or types a higher one. Nothing is numbered until that's confirmed, and it's asked only once. `source = 'typed'` finals carry InvoMax numbers too, so the counter respects them.
- **Order:** the switch to the TS server comes first. As of 2026-11-23 it's built and checked, and the owner does it from checklist step 5. Billing work can be built and tried on the trial copy in the meantime, but it reaches the shop only after the switch.
- **Go-live switch:** `shop-settings.json` gets `"ownBilling": true`. While it's off, Approve & print is hidden, so nothing changes until the owner picks the day. On that day, InvoMax is no longer used for new bills. Turning the InvoMax import off (`"invomaxDir": null`) is a separate, later step, once InvoMax's last bills are in.
- **Trial first:** on the trial copy (`C:\Users\Owner\Downloads\shop-trial\`), the owner tries Approve & print, Fix bill and Reprint with made-up customers before turning it on in the shop.

## Approaches considered
- **A. Print page in our app, printed from the browser** — **picked**. Quickest to build and to adjust until it matches the paper. It needs nothing new installed and is what goes live first.
- **B. A PDF of each bill.** Prints exactly the same everywhere and could be sent to a customer, but it needs a PDF library and is slower to adjust. Not now.
- **C. Print from the phone straight to the desk printer.** No print window, but it needs a print helper installed on the shop PC. A possible later add-on to A.

## Left to the builder
- Table and API shapes (bill snapshot and revisions, counter), the OpenAPI additions and the Orval hooks.
- The print CSS (letter size, margins, fonts close to InvoMax's), and the page-break rule.
- Where Fix bill lives (the admin page or Bill history) and how editing a filled ticket is allowed for the admin only.
- The exact invoice-number rule from the import data (see above).
- What the Shop tickets window (`shopwin.py`) shows once own billing is on. Filled tickets already leave its Ready list.
