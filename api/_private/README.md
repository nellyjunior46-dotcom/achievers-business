# Private original PDF template for Achievers Office

This directory is intended for the EXACT 2-page fillable Tanzania application form (Code 289) supplied by Achievers Club.

Required filename: `tanzania-application-form.pdf`

**Do not** put this PDF in the public website root or in `public/`. The serverless function `api/achievers-application.js` reads the original form from this private directory and only emails applicant-prefilled PDFs to the configured Achievers Office inbox.

The following original PDF fields are intentionally left UNFILLED for the office to complete by hand:
- `Kit Code`
- `ID No` and `Team No` (for office use only)
- `NeoLife ID No` and `Name and Surname` (sponsor)
- payment acknowledgment, signatures, office date, prior registration status.

The applicant-facing page does not link to this document.

Required encrypted Vercel environment settings:
- `ACHIEVERS_OFFICE_EMAIL`: Office destination address provided by Achievers
- `RESEND_API_KEY`: Email API key
- `RESEND_FROM_EMAIL`: Verified email sender
- Optional `ACHIEVERS_APPLICATION_ORIGIN`: Additional custom domain to allow

The form is deliberately NOT accepting sensitive submissions until all of the above and the exact official PDF template are configured.

The Vercel server route reports `{"ready":false}` while setup is incomplete. Do not bypass this gate.

No application is automatically sent to NeoLife. No signature fields are digitally completed.
