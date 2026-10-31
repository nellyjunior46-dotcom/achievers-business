'use strict';

/**
 * Achievers Office application intake.
 *
 * Production requirements (Vercel encrypted environment variables):
 *   ACHIEVERS_OFFICE_EMAIL  - recipient mailbox controlled by Achievers Office
 *   RESEND_API_KEY          - email provider API key (server-side only)
 *   RESEND_FROM_EMAIL       - verified email sender, e.g. forms@your-domain.tld
 *
 * Place the exact 2-page NeoLife 289 fillable PDF uploaded by Achievers in
 * assets/tanzania-application-form.pdf, never expose its PDF URL in the
 * applicant-facing site. The form is filled SERVER-SIDE; the applicant receives
 * no branded PDF and cannot download the partially completed official form.
 *
 * Office-only / sponsor / Kit Code / signatures remain empty.
 * Never treat this request as an electronic signature or completed registration.
 */
const fs=require('fs');
const path=require('path');
const {PDFDocument,StandardFonts}=require('pdf-lib');

const ALLOWED_PAYMENT=['eft','mobile'];
const MAX_JSON_SIZE=16000;
const text=(value,max=180)=>String(value??'').replace(/[\x00-\x1F\x7F]/g,' ').trim().slice(0,max);
const dateText=(value)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||'')))return '';
  const d=new Date(String(value)+'T00:00:00Z');
  if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value)return '';
  if(d.getTime()>Date.now()||d.getUTCFullYear()<1900)return '';
  return value.replaceAll('-','');
};
const phoneOk=(p)=>{const d=p.replace(/\D/g,'');return d.length>=9&&d.length<=15};
const emailOk=(a)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)&&a.length<=180;
const validText=(a,b)=>a.length>=b&&a.length<=180;
const frontFormPath=path.join(process.cwd(),'assets','tanzania-application-form.pdf');

function isReady(){
  return Boolean(process.env.ACHIEVERS_OFFICE_EMAIL
    &&process.env.RESEND_API_KEY
    &&process.env.RESEND_FROM_EMAIL
    &&fs.existsSync(frontFormPath));
}
function sendJSON(res,status,body){
  res.status(status).setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store, max-age=0');
  return res.end(JSON.stringify(body));
}
async function fillOfficialPDF(data){
  const pdf=await PDFDocument.load(fs.readFileSync(frontFormPath));
  const form=pdf.getForm();
  const font=await pdf.embedFont(StandardFonts.Helvetica);
  const fields=[
    ['Surname',data.surname],['First Names',data.firstNames],
    ['ID or Passport',data.applicantId],['Date of Birth',dateText(data.dateOfBirth)],
    ['Email Address',data.email],['Mobile No',data.mobile],
    ['Partners Name',data.partnerName],['Partners Mobile',data.partnerMobile],
    ['Partners Email',data.partnerEmail],['Partners ID or Passport',data.partnerId],
    ['Partners Date of Birth',dateText(data.partnerDob)],
    ['Delivery Address',data.deliveryAddress],
    ['Delivery Address 2',data.deliveryAddress2],['Postal Code',data.postalCode]
  ];
  if(data.paymentMethod==='eft'){
    fields.push(['Bank Name',data.bankName],['Account Name',data.accountName],
      ['Account No',data.accountNo],['Branch Code',data.branchCode],
      ['Branch Name',data.branchName]);
  }else{
    fields.push(['Mobile Number',data.payoutMobile],
      ['Mobile Company Name',data.mobileCompany]);
  }
  // Keep PDF fields fillable: office staff can still print / sign manually.
  // Only write the fields supplied by the applicant, no office-only fields.
  for(const [name,value] of fields){
    const v=text(value,200);
    if(!v)continue;
    const field=form.getTextField(name);
    field.setText(v);
    if(v.length>44)field.setFontSize(8.5);
    else if(v.length>26)field.setFontSize(10);
    else field.setFontSize(11);
  }
  const checkboxNames=[
    data.collectAtCentre==='yes'?'Collect yes':'Collect No',
    data.physicalSame==='yes'?'Physical Address Yes':'Physical Address No',
    data.paymentMethod==='eft'?'EFT':'Mobile',
    data.paymentMethod==='eft'&&data.accountType==='cheque'?'Cheque':null,
    data.paymentMethod==='eft'&&data.accountType==='savings'?'Savings':null
  ].filter(Boolean);
  for(const name of checkboxNames){form.getCheckBox(name).check();}
  // PDF originals with signature widgets should remain unflattened;
  // the member fills the unsigned fields by hand after printing.
  try{form.updateFieldAppearances(font)}catch(_){ /* retain original default appearance */ }
  return Buffer.from(await pdf.save({useObjectStreams:false}));
}
function cleanForm(body){
  const raw=(body&&typeof body==='object'&&!Array.isArray(body))?body:{};
  const input={};
  const allowed=[
    'surname','firstNames','applicantId','dateOfBirth','email','mobile',
    'partnerName','partnerMobile','partnerEmail','partnerId','partnerDob',
    'collectAtCentre','deliveryAddress','deliveryAddress2','postalCode',
    'physicalSame','paymentMethod','bankName','accountName','accountNo',
    'branchCode','branchName','accountType','payoutMobile','mobileCompany'
  ];
  for(const key of allowed){input[key]=text(raw[key],key==='deliveryAddress'?240:180);}
  if(text(raw.company_website))return {valid:false};
  const valid=validText(input.surname,2)&&validText(input.firstNames,2)
    &&validText(input.applicantId,4)&&!!dateText(input.dateOfBirth)
    &&emailOk(input.email)&&phoneOk(input.mobile)
    &&(input.partnerEmail===''||emailOk(input.partnerEmail))
    &&(input.partnerDob===''||!!dateText(input.partnerDob))
    &&['yes','no'].includes(input.collectAtCentre)
    &&input.deliveryAddress.length>=6
    &&['yes','no'].includes(input.physicalSame)
    &&ALLOWED_PAYMENT.includes(input.paymentMethod)
    &&(input.paymentMethod==='eft'
      ?['bankName','accountName','accountNo','branchCode','branchName'].every(k=>input[k].length>=2)
        &&['cheque','savings'].includes(input.accountType)
      :phoneOk(input.payoutMobile)&&input.mobileCompany.length>=2);
  return {valid,input};
}
module.exports=async function handler(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET')return sendJSON(res,200,{ready:isReady()});
  if(req.method!=='POST')return sendJSON(res,405,{ok:false,message:'Method not allowed.'});
  const origin=req.headers.origin||'';
  const allowedOrigins=[
    'https://achievers-business.vercel.app',
    process.env.ACHIEVERS_APPLICATION_ORIGIN||''
  ].filter(Boolean);
  if(origin && !allowedOrigins.includes(origin))return sendJSON(res,403,{ok:false,message:'Invalid origin.'});
  const length=Number(req.headers['content-length']||0);
  if(length>MAX_JSON_SIZE)return sendJSON(res,413,{ok:false,message:'Form data too large.'});
  if(!isReady())return sendJSON(res,503,{ok:false,message:'Application submission is being configured by Achievers Office. Please contact the office.'});
  const {valid,input}=cleanForm(req.body);
  if(!valid)return sendJSON(res,400,{ok:false,message:'Please check the application fields and try again.'});
  // Do not log raw applicant data or PDF bytes.
  try{
    const pdf=await fillOfficialPDF(input);
    const stamp=new Date().toISOString().replace(/[^\d]/g,'').slice(0,14);
    const safeName=(input.surname+'-'+input.firstNames).replace(/[^a-zA-Z0-9-]+/g,'-').slice(0,55);
    const filename='Achievers-Application-'+safeName+'-'+stamp+'.pdf';
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',headers:{'Authorization':'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({
        from:process.env.RESEND_FROM_EMAIL,
        to:[process.env.ACHIEVERS_OFFICE_EMAIL],
        subject:'Achievers Application - '+input.surname+' '+input.firstNames,
        html:'<p>Achievers Office,</p><p>A new applicant has submitted their details. The attached official application form contains the applicant and payout sections. Please download and print the PDF, then complete Kit Code, office and sponsor details manually as required.</p><p>No application has been forwarded to any external organization.</p>',
        attachments:[{filename,content:pdf.toString('base64')}]
      })
    });
    if(!response.ok){
      // Do not disclose provider details or applicant data in HTTP response.
      return sendJSON(res,502,{ok:false,message:'Could not deliver the application to Achievers Office. Please try again.'});
    }
    return sendJSON(res,200,{ok:true,message:'Application received by Achievers Office.'});
  }catch(error){
    // No raw applicant data in logs. Avoid exposing internal file path or provider credentials.
    console.error('Achievers application processing failed:',error?.name||'ServerError');
    return sendJSON(res,500,{ok:false,message:'Application could not be processed. Please try again.'});
  }
};
