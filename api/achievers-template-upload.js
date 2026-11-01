'use strict';

const {createHash,timingSafeEqual}=require('node:crypto');
const {PDFDocument}=require('pdf-lib');
const {put}=require('@vercel/blob');

const TEMPLATE_PATH='templates/application-form-289.pdf';
const EXPECTED_SHA256='4a9c217357c6b6a8d95af355ef5d2af469a1208f52833d9d1d0fa46086fbb1f3';
const REQUIRED_FIELDS=['Surname','First Names','ID or Passport','Date of Birth',
  'Email Address','Mobile No','Delivery Address','Collect yes','Collect No',
  'Physical Address Yes','EFT','Bank Name','Account No','Mobile',
  'Mobile Number','Mobile Company Name'];

function send(res,status,body){
  res.status(status).setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  return res.end(JSON.stringify(body));
}
function authorized(req){
  const configured=process.env.ACHIEVERS_ADMIN_UPLOAD_TOKEN||'';
  const candidate=String(req.headers['x-admin-token']||'');
  const a=Buffer.from(candidate);
  const b=Buffer.from(configured);
  return b.length>=32&&a.length===b.length&&timingSafeEqual(a,b);
}

module.exports=async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{ok:false,message:'Method not allowed.'});
  if(!authorized(req))return send(res,401,{ok:false,message:'Invalid office upload passcode.'});
  if(!process.env.BLOB_READ_WRITE_TOKEN)return send(res,503,{ok:false,message:'Private document storage is not ready.'});
  const origin=String(req.headers.origin||'');
  if(origin&&!['https://achievers-business.vercel.app','https://achievers-business-sanisol.vercel.app'].includes(origin)){
    return send(res,403,{ok:false,message:'Invalid origin.'});
  }
  if(Number(req.headers['content-length']||0)>500000)return send(res,413,{ok:false,message:'PDF exceeds allowed size.'});
  const data=req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:{};
  const encoded=typeof data.pdfBase64==='string'?data.pdfBase64:'';
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length>440000){
    return send(res,400,{ok:false,message:'Choose the original PDF file.'});
  }
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length<50000||bytes.length>300000||bytes.subarray(0,5).toString()!=='%PDF-'){
    return send(res,400,{ok:false,message:'Invalid application PDF.'});
  }
  if(createHash('sha256').update(bytes).digest('hex')!==EXPECTED_SHA256){
    return send(res,400,{ok:false,message:'Please upload the exact Tanzania application form provided to Achievers.'});
  }
  try{
    const pdf=await PDFDocument.load(bytes);
    if(pdf.getPageCount()!==2)throw new Error('Expected a two-page document');
    const form=pdf.getForm();
    for(const name of REQUIRED_FIELDS){
      if(name==='Collect yes'||name==='Collect No'||name==='Physical Address Yes'||name==='EFT'||name==='Mobile'){
        form.getCheckBox(name);
      }else{
        form.getTextField(name);
      }
    }
    await put(TEMPLATE_PATH,bytes,{
      access:'private',contentType:'application/pdf',allowOverwrite:true,addRandomSuffix:false
    });
    return send(res,200,{ok:true,message:'Original official PDF stored securely. Applicant submissions can now use the template.'});
  }catch(err){
    console.error('Achievers template setup failed:',err?.name||'ServerError');
    return send(res,500,{ok:false,message:'Could not connect the PDF template. Please try again.'});
  }
};