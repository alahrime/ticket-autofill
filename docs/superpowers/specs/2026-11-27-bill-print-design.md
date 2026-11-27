# The printed bill, redesigned — design

**Date:** 2026-11-27. **Status:** approved by the owner on 2026-11-27 (design A, "classic, cleaned up", after several mockup rounds).
**Final mockup:** `docs/superpowers/specs/2026-11-27-bill-print-mockup.html`. Open it in a browser. It uses the server's frame classes, so plain styling is approximate, but the layout and proportions are the approved ones.

This is part 1 of 3 in the owner's request of 2026-11-27. The order is: **1. the printed bill**, 2. matching past InvoMax lines to jobs, 3. the admin bills dashboard (monthly reports and customer/vehicle service history). Parts 2 and 3 get their own designs.

## Why
Our app prints the shop's bills since 2026-11-27 (own billing went live). The first version copied InvoMax's printout closely and looks cramped. The signature space is a dotted line, the fine print is 6.5 pt, and the vehicle details run together. The owner wants the bill to look professional and be easy to read. It needs room for a logo they are designing, and room for more lines on big jobs.

## Goals
- Easier to read and more polished, with nothing clipped or overflowing, ever.
- A logo spot at the top right.
- A real signature area.
- **More lines per page than today:** 24 per table on page 1, against 20 today.
- The same information and wording as today's bill (the InvoMax wording), except the two removals below.

## Non-goals
- No change to the money rules, invoice numbers, the two copies, revisions or how a reprint looks the same as the original.
- No change to the desk page. Price editing on the ticket lines before Approve & print stays exactly as it is (owner, 2026-11-27).
- No discount box, used-parts mark or anything else the own-billing design left out.

## Anti-goals
- Any text cut off, shortened or overflowing its box. The full liability and authorization wording must always print.
- Fewer lines per page than today.
- Type smaller than 7 pt.

## Approaches considered
- **A. Classic, cleaned up (chosen):** InvoMax's arrangement, with labor on the left and parts on the right, boxes and rules, and grey heading bands. It adds more room, labels and better type. Staff and customers already know the layout.
- **B. Modern:** labeled cards, one combined list of labor and parts, merged empty total rows, and a big balance-due strip. The owner preferred A.

## The layout (top to bottom), as approved
1. **Header:**
   - Left: the shop name in a bold serif, about 22 pt, letter-spaced, with a thin rule under it.
   - Under the name: the address on one line ("3413 WILSON BLVD | ARLINGTON, VA 22201"), slightly letter-spaced.
   - Then one contact line: a small grey `TEL` label and the phone, a thin divider, then a small grey `HOURS` label and the hours.
   - Right: the **logo box**, about 2.4 × 0.8 in.
2. **Customer and vehicle**, one bordered box split in two (vehicle side wider, about 1 : 2.1):
   - **Layout:** each side is a list with the field name on the left in grey and the value on the right in bold. A faint dotted line separates rows. There are no "Customer"/"Vehicle" titles.
   - **Customer side:** Name, Phone.
   - **Vehicle side:** first a full-width row, "Year / Make / Model", with the value "2019 CADILLAC XT5". Under it, two columns: License and Mechanic | Odometer and VIN. A 17-character VIN must fit on one line. **Odometer** is one row showing the ticket's single (final) reading (owner, 2026-11-27).
3. **Invoice bar:** grey and bordered. It holds Date, Schedule, **INVOICE : number** (bold and larger), and "Page N of M". **The time is not printed** (owner). It stays in the bill's record (`BillSnapshot.time`) and wherever the app shows it.
4. **Lines:**
   - Labor on the left ("REMARKS AND LABOR DESCRIPTIONS", PRICE) and parts on the right ("PARTS & LUBRICANTS", QTY, PRICE, TOTAL).
   - Grey heading band.
   - **Alternating row shading** in both tables: every other row light grey (about #e9e9e9), starting with the second line, continuing through the empty rows to the bottom of the box.
   - Rows are 0.2 in, as today. The tables fill all the height left between the bar and the bottom block.
   - **Rows stay aligned across both sides (owner, 2026-11-27).** When a long description wraps on one side, that row is just as tall on the other side, so every following line stays level. Labor line N and parts line N always sit on the same row, and the shading stays even. The simplest way to build this is one table whose rows each pair labor N with parts N, with the thick rule between the two halves. The builder may choose another way that gives the same result.
5. **Bottom block, three columns** (about 1.2 : 1 : 0.92):
   - **Left:**
     - The price-increase approval box (DATE TIME PHONE APPROVED AMOUNT, with a write-in line and its sentence).
     - The CHARGE line, with the parts-new and storage notes in about 8 pt.
     - The **signature box**, which takes all the height left in the column. It holds the "ACCEPTANCE SIGNATURE" heading, the acceptance sentence, and one signature line about 2.5 in wide at the bottom, with about 0.7 in of clear space above it. A bold **"X"** sits at the left end of the signature line, where the customer signs (owner, 2026-11-27). **There is no date line** (owner): the date is already in the bar.
   - **Middle:** the **full** liability and authorization paragraphs, unshortened, at about 7.1 pt, left-aligned.
   - **Right:** all of today's total rows, unchanged (Parts & Lubricants, Labor, Sublet, Haz. Disposal, Shop Supply, Gasoline, Sub Total, Sales Tax, Deposit, Disc. Applied). Deposit and Disc. Applied keep the grey band. TOTAL is bold. **BALANCE DUE** is a black bar with white text, kept on one line.
6. **Phone numbers:** printed as `(703) 522-3100`, with a space after the area code. This applies to the shop's phone and the customer's, whatever way they were typed. A number that isn't 10 digits (or 11 starting with 1) prints as typed.

## Owner's answers (2026-11-27)
- **Logo:** for now the top-right spot prints as **blank space**, with no outline and no text. The owner adds a logo later.
  - Claude's call: build the logo support now so adding it later is only a file drop. The admin puts `logo.png`, `logo.jpg` or `logo.svg` in the shop root, next to `shop-settings.json`. The server serves it to signed-in admins only. The print page shows it scaled to fit about 2.4 × 0.8 in, keeping its proportions and never cropped.
  - A wide logo (about 3 : 1) fits best.
- **Odometer:** one reading, the final one.
- **Hours:** the shop closes at **6 PM**. The settings text becomes `MON–FRI 8:00 AM – 6:00 PM`, set in `shop-settings.json` on 2026-11-27. The bill prints `shop.hours` as written.
- **Long descriptions:** they wrap rather than being cut off, and the other side's row grows to match, so rows stay aligned (see Layout 4).
- **Two-page bills:** the owner expects them to be very rare now that 24 lines fit. Keep today's continuation behavior as a safety net ("Page N of M", "Continued on the next page"), but don't build anything more for it.

## Decided by Claude (the owner can overrule)
- **Shading in print:** keep `print-color-adjust: exact`, so the grey rows and bands print with the browser's "Background graphics" setting off.
- **Pagination:** with paired rows, a page budgets rows by the taller side of each pair (a wrapped line counts double on both sides).

## Constraints
- Letter paper, 0.4 in margins, two copies per print. Each copy's pages start on a new sheet, as today.
- Pagination (`apps/admin-app/src/print/paginate.ts`) must be recalibrated to the new layout: `ROWS_PER_PAGE` goes to **24**, along with its header and bottom heights and characters per line. A test must show 24 one-line rows in each table fitting page 1 with no overflow, and a long bill splitting cleanly with "Page N of M".
- The page is checked in the real browser print (Edge/Chrome, letter). Nothing may overflow at the 0.2 in row height and the type sizes above.
- The existing print tests and the own-billing e2e test keep passing, updated for the new wording ("Page 1 of 1", no time).
- Standing rules: no customer data in git or tests (use JANE DOE, (555) 010-0000, XKS-4827, invoices 9000001+); no CDN or web fonts (Times New Roman and Arial are system fonts).

## Left to the builder
- Exact CSS values, as long as the measured results hold: 24 rows on page 1, the signature line about 2.5 in with about 0.7 in of space, fine print at 7 pt or more, nothing overflowing.
- How the logo is served (route name, caching) within the existing admin-only rules.
