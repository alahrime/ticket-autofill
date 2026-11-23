// The bill's fixed wording, in one place so it can change without touching the layout. Transcribed from
// InvoMax's printout (spec: "The fixed wording"): spacing and the two typos ("STRORAGE", "intial") corrected.

/** The oral-approval box: its column headings, then the notice under its line. */
export const APPROVAL_COLUMNS = ['DATE', 'TIME', 'PHONE', 'APPROVED', 'AMOUNT'] as const;
export const APPROVAL_NOTICE = 'I acknowledge notice and oral approval of an increase in the original estimated price';
export const CHARGE = 'CHARGE';

/** The box next to Labor / Sublet. */
export const PARTS_NEW = 'All Parts Are New Unless Shown As (U) Used';

export const STORAGE_NOTICE = 'DAILY STORAGE 24HRS AFTER JOB DONE $65.00. BY SIGNING I WILL NOT DISPUTE THE CHARGES.';

/** The signature line: `X ........` is drawn by the layout. The title is spread out with letter-spacing. */
export const ACCEPTANCE_SIGNATURE = 'ACCEPTANCE SIGNATURE';
export const ACCEPTANCE_TERMS = 'I accept the charges and terms of this agreement.';

/** The liability box; the line to initial is drawn after it by the layout. */
export const LIABILITY =
  'Under no circumstances shall J.A.S. be liable for any damages resulting from the use or inability to use the vehicle. All parts are new unless specified as (u) used. Removed parts will be disposed of unless I initial here';

export const AUTHORIZATION =
  'I authorize the above repairs and materials. J.A.S. may operate vehicles for testing at my risk. J.A.S. is not responsible for loss or damage to vehicle or items left in it. I agree to pay reasonable storage fees on car if left more than 1 working day. I understand that labor is warranted for 90 days or 4000 miles. I agree that all warranty shall be void if corrective action is performed elsewhere. If J.A.S. is unable to repair warranted work performed under this invoice after undertaking reasonable efforts to do so, in its sole discretion, refund the original amount charged for labor under this invoice. My acceptance of such refund shall waive all warranty claims hereunder. In no event shall J.A.S. be responsible for indirect, consequential, or punitive damages.';
