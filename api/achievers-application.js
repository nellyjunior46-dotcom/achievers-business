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
 * api/_private/tanzania-application-form.pdf, never expose its PDF URL in the
 * applicant-facing site. The form is filled SERVER-SIDE; the applicant receives
 * no branded PDF and cannot download the partially completed official form.
 *
 * Office-only / sponsor / Kit Code / signatures remain empty.
 * Never treat this request as an electronic signature or completed registration.
 */
const {PDFDocument,StandardFonts}=require('pdf-lib');
const {head,get}=require('@vercel/blob');
const {Readable}=require('node:stream');
const {createHmac,timingSafeEqual}=require('node:crypto');

// Office destination confirmed for production by Achievers Club.
const OFFICE_EMAIL='naimakunambi@gmail.com';

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
const TEMPLATE_PATH='templates/application-form-289.pdf';
async function isReady(){
  if(!(process.env.RESEND_API_KEY
    &&process.env.RESEND_FROM_EMAIL&&process.env.BLOB_READ_WRITE_TOKEN))return false;
  try {
    const doc=await head(TEMPLATE_PATH,{access:'private'});
    return Boolean(doc?.pathname===TEMPLATE_PATH);
  } catch { return false; }
}
async function loadOfficialTemplate(){
  const response=await get(TEMPLATE_PATH,{access:'private',useCache:false});
  if(response?.statusCode!==200||!response.stream)throw new Error('Missing private PDF template');
  const chunks=[];let total=0;
  for await(const chunk of Readable.fromWeb(response.stream)){
    total+=chunk.length;
    if(total>800000)throw new Error('Private PDF template is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function sendJSON(res,status,body){
  res.status(status).setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store, max-age=0');
  return res.end(JSON.stringify(body));
}
async function fillOfficialPDF(data){
  const pdf=await PDFDocument.load(await loadOfficialTemplate());
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
    // The official PDF uses comb boxes with limits as low as 5-21 characters.
    // Keep the COMPLETE value: disable combs for longer content instead of
    // silently dropping a long email, address, name or bank account detail.
    const limit=field.getMaxLength();
    if(limit!==undefined && v.length>limit){
      field.disableCombing();
      field.removeMaxLength();
    }
    field.setText(v);
    const size=v.length>100?5:v.length>75?6:v.length>48?7:v.length>30?8.5:11;
    try{field.setFontSize(size)}catch(_){ /* some source widgets use custom DA */ }
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
  const valid=raw.consent===true&&validText(input.surname,2)&&validText(input.firstNames,2)
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

/**
 * A short-lived, tamper-resistant follow-up token ties the payment choice to
 * the applicant whose completed official PDF was successfully emailed.
 * No separate database or second collection of identification data is needed.
 */
function signPaymentToken(input){
  const record={
    name:text(input.firstNames+' '+input.surname,160),
    mobile:input.mobile,
    email:input.email,
    created:Date.now()
  };
  const payload=Buffer.from(JSON.stringify(record)).toString('base64url');
  const signature=createHmac('sha256',process.env.RESEND_API_KEY).update(payload).digest('base64url');
  return payload+'.'+signature;
}
function verifyPaymentToken(token){
  if(typeof token!=='string'||token.length>1600)return null;
  const parts=token.split('.');
  if(parts.length!==2||!parts[0]||!parts[1])return null;
  const expected=createHmac('sha256',process.env.RESEND_API_KEY).update(parts[0]).digest('base64url');
  if(parts[1].length!==expected.length||
      !timingSafeEqual(Buffer.from(parts[1]),Buffer.from(expected)))return null;
  try{
    const data=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    if(!Number.isSafeInteger(data.created)||data.created>Date.now()+120000||
        Date.now()-data.created>7*86400000||!validText(text(data.name),2)||
        !emailOk(text(data.email))||!phoneOk(text(data.mobile)))return null;
    return {name:text(data.name,160),email:text(data.email),mobile:text(data.mobile)};
  }catch(_){return null;}
}
async function notifyWednesdayChoice(req,res){
  if(!(process.env.RESEND_API_KEY&&process.env.RESEND_FROM_EMAIL)){
    return sendJSON(res,503,{ok:false,message:'Payment preference notifications are unavailable.'});
  }
  if(req.body?.choice!=='wednesday')return sendJSON(res,400,{ok:false,message:'Invalid payment choice.'});
  const applicant=verifyPaymentToken(req.body?.token);
  if(!applicant)return sendJSON(res,403,{ok:false,message:'This application confirmation has expired. Please contact Achievers Office.'});
  try{
    const details=[
      'Achievers Office,',
      '',
      'An applicant who submitted the official application has selected PAY ON WEDNESDAY.',
      '',
      'Applicant: '+applicant.name,
      'Mobile / WhatsApp: '+applicant.mobile,
      'Email: '+applicant.email,
      'Payment intention: Pay on Wednesday',
      '',
      'The completed application PDF was sent in the original application email.',
      'This is a payment intention only; payment has NOT been received or confirmed.'
    ].join('\n');
    const response=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{'Authorization':'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({
        from:process.env.RESEND_FROM_EMAIL,
        to:[OFFICE_EMAIL],
        subject:'Achievers - Pay on Wednesday - '+applicant.name,
        text:details
      })
    });
    if(!response.ok)return sendJSON(res,502,{ok:false,message:'Could not notify Achievers Office. Please try again.'});
    return sendJSON(res,200,{ok:true,message:'Achievers Office has been informed that you plan to pay on Wednesday.'});
  }catch(_){
    return sendJSON(res,500,{ok:false,message:'Unable to save your payment preference. Please try again.'});
  }
}
module.exports=async function handler(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET')return sendJSON(res,200,{ready:await isReady()});
  if(req.method!=='POST')return sendJSON(res,405,{ok:false,message:'Method not allowed.'});
  const origin=req.headers.origin||'';
  const allowedOrigins=[
    'https://achievers-business.vercel.app',
    process.env.ACHIEVERS_APPLICATION_ORIGIN||''
  ].filter(Boolean);
  if(origin && !allowedOrigins.includes(origin))return sendJSON(res,403,{ok:false,message:'Invalid origin.'});
  const length=Number(req.headers['content-length']||0);
  if(length>MAX_JSON_SIZE)return sendJSON(res,413,{ok:false,message:'Form data too large.'});
  if(req.body?.action==='payment-choice')return notifyWednesdayChoice(req,res);
  if(!(await isReady()))return sendJSON(res,503,{ok:false,message:'Application submission is being configured by Achievers Office. Please contact the office.'});
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
        to:[OFFICE_EMAIL],
        subject:'Achievers Application - '+input.surname+' '+input.firstNames,
        html:'<p>Achievers Office,</p><p>A new applicant has submitted their details. The attached official application form contains the applicant and payout sections. Please download and print the PDF, then complete Kit Code, office and sponsor details manually as required.</p><p>No application has been forwarded to any external organization.</p>',
        attachments:[{filename,content:pdf.toString('base64')}]
      })
    });
    if(!response.ok){
      // Do not disclose provider details or applicant data in HTTP response.
      return sendJSON(res,502,{ok:false,message:'Could not deliver the application to Achievers Office. Please try again.'});
    }
    return sendJSON(res,200,{ok:true,message:'Application received by Achievers Office.',paymentToken:signPaymentToken(input)});
  }catch(error){
    // No raw applicant data in logs. Avoid exposing internal file path or provider credentials.
    console.error('Achievers application processing failed:',error?.name||'ServerError');
    return sendJSON(res,500,{ok:false,message:'Application could not be processed. Please try again.'});
  }
};
