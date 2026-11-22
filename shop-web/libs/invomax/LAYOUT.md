# InvoMax's Btrieve files: layout

Mapped 2026-11-21 from copies of the shop's `INVOICE.btv` and `DETAIL.btv` (the 2026-11-21 backup and a live copy). A throwaway decoder built from this layout found **exactly the header's record count in both files, on both copies** (INVOICE 53,447; DETAIL 245,602), and every record unpacked to its full length. Example values below are made up.

Both files are **Btrieve 5.x** files with data compression. `CUSTOMERw.btv` is a later version (it starts with `FC`) and is not read in phase 4.

## Numbers

Numbers are little-endian unless noted. A **page number** is 4 bytes stored as two u16 words, high word first: page = `(u16@0 << 16) | u16@2`.

## File header (page 0)

| Offset | Type | Meaning |
|---|---|---|
| 0x08 | u16 | page size: INVOICE 1536, DETAIL 1024 |
| 0x14 | u16 | number of keys: INVOICE 10, DETAIL 8. Not needed. |
| 0x1A | u16 + u16 | record count: `(u16@0x1A << 16) \| u16@0x1C` |
| 0x10E | u16 | record length, unpacked: INVOICE 498, DETAIL 265 |

## Pages

The file is a run of pages of the header's page size; page 0 is the header. Index pages and other kinds are mixed in among the record pages, so every page has to be tested.

A **fragment page** is a page that passes every check below:

| Bytes | Meaning |
|---|---|
| 0–3 | the page's own number; it **must equal its position** (`offset / pageSize`) |
| 4–5 | usage count (ignored) |
| 6–9 | varies (ignored) |
| 10–11 | `cnt`: the number of fragment slots; it must satisfy `0 < cnt < (pageSize − 12) / 2` |
| 12… | fragment data |
| last `2·(cnt+1)` bytes | the slot table, read **backwards from the end** |

The slot table works like this:
- Slot `i` is the u16 at `pageSize − 2 − 2·i`, for `i = 0 … cnt`.
- Slots `0 … cnt−1` are fragments; slot `cnt` is the free-space offset.
- A slot value of `0xFFFF` is an empty (deleted) slot.
- Otherwise, bits 0–14 give the fragment's start offset and **bit 15 means the fragment is chained**.

Further checks on the table:
- The smallest live offset must be 12.
- The live offsets plus the free offset must all be different.
- The free offset must be at most `pageSize − 2·(cnt+1)`.

A page that fails any of these is not a fragment page; skip it.

A fragment runs from its start offset to the next larger offset among the live offsets and the free offset.

## Records

- **Chained fragments:** a fragment with bit 15 set begins with a 4-byte **pointer to the next fragment** of the same record. The pointer's bytes are `b0 b1 b2 slot`, and the page is `(b0 << 16) | b1 | (b2 << 8)`. The fragment's own data follows the pointer.
- **Unchained fragments:** a fragment without the bit is all data, and it is the last fragment of its record.
- **Heads:** a fragment that no pointer points to starts a record. **There is one head per record**, and the number of heads must equal the header's record count.
- **Joining:** a record's packed bytes are its head's data, then each following fragment's data along the chain. A pointer to a slot that doesn't exist means a broken file: fail.
- **Unpacking:** read a u16 count `n` and copy the next `n` bytes. Then read a u16 count `r` and one byte, and write that byte `r` times. Repeat until the record length is reached. The result must be exactly the header's record length, otherwise fail.

## Field types

- **`str(max)`:** a Pascal short string, one length byte then the characters (latin1), taking `1 + max` bytes. Cap a length byte above `max` at `max`.
- **`real48`:** Turbo Pascal 6-byte Real. Byte 0 is the exponent (0 means the value 0) with a bias of 129. Bytes 1–5 are the mantissa, little-endian, 39 bits plus the sign in the top bit: `value = ±(1 + m / 2^39) · 2^(e − 129)`. Money is `Math.round(value · 100)` cents.
- **`text number`:** a `str` holding a right-aligned decimal, for example `"   48.27"`. Blank means 0, and anything that won't parse means null.

## INVOICE record (498 bytes)

| Offset | Type | Field |
|---|---|---|
| 5 | str(8) | invoice no.: 6 digits before ~2024, 7 since; older ones have 4–5 digits. **Unique** across the file. |
| 14 | str(8) | customer key, e.g. `DOE_2` |
| 23 | str(8) | date `MMDDYYYY`. About 6% of bills have it blank or garbled (`'05/204'`); then use the first line's date (DETAIL @256). |
| 60 | str(8) | plate, as typed (`XKS-4827`) |
| 78 | str(28) | customer's full name, `JANE DOE`; there are no separate first/last fields |
| 107 | str(14) | phone, as typed (`(555)010-0000`) |
| 136 | real48 | total |
| 142 | real48 | balance due |
| 172 | real48 | tax |
| 204 | real48 | discount |
| 272 | real48 | parts + labor on some older bills, labor on most. **Not used**; use 403. |
| 284 | str(28) | address line (city, state, zip on recent bills) |
| 313 | str(28) | second address line (often blank) |
| 372 | real48 | tax rate (0.06) |
| 403 | real48 | **labor**: equals the sum of the labor lines on 99.3% of bills since 2010 |
| 409 | real48 | deposit |
| 415 | real48 | **parts**: equals the sum of the part lines |
| 445 | real48 | supplies |

**VIN:** INVOICE and DETAIL have no VIN field. VIN-like strings appear only in `CUSTOMERw.btv` (about 2,600, a later Btrieve version, not decoded), and sometimes typed inside line descriptions. **Phase 4 doesn't import VINs; VIN search covers our tickets only.**

## DETAIL record (265 bytes, one per bill line)

| Offset | Type | Field |
|---|---|---|
| 4 | str(8) | invoice no. (joins to INVOICE @5; 41 of 245,602 lines have no bill) |
| 13 | str(8) | code (`FBP`, `LABOR`, `INSTALL-`, `NOTE`) |
| 22 | str(30) | vehicle text, `2019 Honda HR-V EX` |
| 53 | text number str(9) | shop's cost each (not used) |
| 63 | text number str(8) | quantity |
| 81 | u8 | line order within the bill (0-based; can repeat; sort by it, then by file order) |
| 96 | str(12) | usually a number; **a word (`VISA_1`, `CASH`, `Ck`) marks a payment line** |
| 111 | char | kind: `M` part, `L` labor, `*` note, other |
| 127 | text number str(13) | **unit price**: qty × unit price = the line's amount |
| 141 | str(20) | part number / second code |
| 162 | str(50) | description |
| 213 | str(42) | customer key (as INVOICE @14) |
| 256 | str(8) | line date, `YYMMDD` (YY 00–40 means 20YY, otherwise 19YY) |

**How lines map to `ImLine.kind`:**
- `M` is part and `L` is labor.
- `*`, any other kind, and **payment lines** are `other`. A payment line is one whose @96 holds a word, or whose code is `DEPOSIT`, as on older bills.
- With payments excluded, the part lines sum to INVOICE parts and the labor lines to INVOICE labor (@403). This holds on 98.7% of bills since 2020 and 98.5–99.4% in earlier decades.

**`GENERIC_CODES`** (exported from `@shop/invomax`) are the codes whose job is named only in the description: `LABOR` (about 4,100 different descriptions since 2022) and `INSTALL-` (about 3,400). `NOTE`/`NOTEP` are note lines (`*`), not jobs.

## Owner check

The owner compared the decoded lines of 3 recent bills (one with a deposit, one with a part entered as labor) with InvoMax's screen on 2026-11-21: **all match**.
