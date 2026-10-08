'use strict';
// Fixed local connector only. Never imported by backend/start or a poller.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {prepareStore,secureReadText}=require('../../src/lib/supportEmailInstaller');
const {loadSendConfig,validateSendGrant,SEND_GRANT}=require('./send-config');
const {createSendOAuth,CLIENT,REDIRECT,SCOPE}=require('./send-oauth');
const HOST='127.0.0.1:43873',ORIGIN='http://'+HOST;
const fail=()=>{throw Error('SUPPORT_EMAIL_SEND_INSTALLER');};
const equal=(a,b)=>typeof a==='string'&&/^[A-Za-z0-9_-]{43}$/.test(a)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'none'; script-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"};
function storeSendGrant(grant,binding,now=Date.now) {
  if(loadSendConfig('connect').binding!==binding||grant.mailbox!=='alphy@alphasourceai.com'||grant.scope!==SCOPE||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=now())fail();
  const saved=validateSendGrant({clientId:CLIENT,mailbox:grant.mailbox,scope:SCOPE,refreshToken:grant.refreshToken,capturedAt:new Date(now()).toISOString(),accessTokenExpiresAt:grant.expiresAt});
  prepareStore(SEND_GRANT);
  const tmp=path.join(path.dirname(SEND_GRANT),'.send-grant-'+randomBytes(16).toString('hex'));
  let fd,inode,committed=false;
  try {
    fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);inode=fs.fstatSync(fd).ino;
    fs.writeFileSync(fd,JSON.stringify(saved)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    if(loadSendConfig('connect').binding!==binding)fail();prepareStore(SEND_GRANT);
    fs.linkSync(tmp,SEND_GRANT);committed=true;fs.unlinkSync(tmp);
    const read=validateSendGrant(JSON.parse(secureReadText(SEND_GRANT)));
    if(JSON.stringify(read)!==JSON.stringify(saved))fail();
    const dir=fs.openSync(path.dirname(SEND_GRANT),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  } catch(_){if(fd!==undefined)fs.closeSync(fd);try{if(fs.lstatSync(tmp).ino===inode)fs.unlinkSync(tmp);}catch(_){/* Only own unpublished temp. */}
    const error=Error('SUPPORT_EMAIL_SEND_STORAGE');error.committed=committed;throw error;}
}
function createSendInstaller({initial,load=loadSendConfig,save=storeSendGrant,fetchImpl=fetch,now=Date.now}) {
  const check=()=>{if(load('connect').binding!==initial.binding)fail();};check();
  const oauth=createSendOAuth({client:initial.sendClient,fetchImpl,now});
  const bootstrap=randomBytes(32).toString('base64url'),session=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
  const deadline=now()+300000;let stage='new',cancelled=false;
  const response=(status,body,extra={})=>({status,body,headers:{...headers,...extra}});
  const denied=()=>response(403,'<p>Connection request rejected.</p>');
  const ended=code=>({...response(code==='CONNECTED'?200:400,code==='CONNECTED'?'<p>alphy QA sending connection saved. Automatic replies remain off. No email sent.</p>':'<p>Connection stopped. Inspect the local status before retrying.</p>'),terminal:code});
  function cookie(value){const rows=typeof value==='string'?value.split(';').map(x=>x.trim()).filter(x=>x.startsWith('alphy_qa_send_session=')):[];
    return rows.length===1&&equal(rows[0].slice('alphy_qa_send_session='.length),session);}
  return {deadline,bootstrapUrl:ORIGIN+'/oauth/bootstrap/'+bootstrap,abort(){cancelled=true;},async handle({method,url,headers:h={},body=''}) {
    if(h.host!==HOST||typeof url!=='string'||url.length>8192||!url.startsWith('/')||url.startsWith('//'))return denied();
    try{check();}catch(_){stage='done';return ended('CONFIG_CHANGED');}
    if(cancelled||now()>=deadline){stage='done';return ended('EXPIRED');}
    const u=new URL(url,ORIGIN);
    if(stage==='new'&&method==='GET'&&u.pathname==='/oauth/bootstrap/'+bootstrap&&!u.search){
      if(h.origin&&h.origin!==ORIGIN)return denied();stage='form';
      return response(200,'<h1>alphy QA sending connection</h1><p>Connect only alphy@alphasourceai.com. Gmail send plus verified email identity. No automatic sending.</p>'+
        '<p>Client: '+CLIENT+'</p><p>Redirect: '+REDIRECT+'</p><p>Grant: '+SEND_GRANT+'</p>'+
        '<form method="post" action="/oauth/connect"><input type="hidden" name="csrf" value="'+csrf+'"><button>Connect alphy sending</button></form>',
        {'Set-Cookie':'alphy_qa_send_session='+session+'; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=300',
          'Content-Security-Policy':"default-src 'none'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action "+ORIGIN});
    }
    if(!cookie(h.cookie))return denied();
    if(stage==='form'&&method==='POST'&&u.pathname==='/oauth/connect'){
      const local=h.origin===ORIGIN||(h.origin==='null'&&h['sec-fetch-site']==='same-origin'&&h['sec-fetch-mode']==='navigate'&&h['sec-fetch-dest']==='document');
      const fields=new URLSearchParams(body);
      if(u.search||!local||h['content-type']!=='application/x-www-form-urlencoded'||Buffer.byteLength(body)>256||[...fields.keys()].length!==1||!equal(fields.get('csrf'),csrf))return denied();
      check();stage='waiting';const auth=new URL(oauth.begin());
      if(auth.origin+auth.pathname!=='https://accounts.google.com/o/oauth2/v2/auth'||auth.searchParams.get('client_id')!==CLIENT||auth.searchParams.get('scope')!==SCOPE||auth.searchParams.get('redirect_uri')!==REDIRECT)fail();
      return response(200,'<h1>Continue to Google</h1><p>Choose only alphy@alphasourceai.com. Gmail sending and email identity only; no email is sent by connecting.</p><a rel="noreferrer noopener" href="'+auth.href.replace(/&/g,'&amp;')+'">Continue to Google — alphy sending</a>');
    }
    if(stage==='waiting'&&method==='GET'&&u.pathname==='/oauth/callback'){
      stage='busy';const keys=[...u.searchParams.keys()],allowed=['state','code','error','scope','authuser','prompt','iss'];
      if(keys.some(k=>!allowed.includes(k))||keys.length!==new Set(keys).size||!u.searchParams.has('state')||u.searchParams.has('code')===u.searchParams.has('error')||
        (u.searchParams.has('iss')&&u.searchParams.get('iss')!=='https://accounts.google.com')){stage='done';return ended('FAILED');}
      let grant;
      try{check();grant=await oauth.complete(Object.fromEntries(u.searchParams));check();if(cancelled||now()>=deadline)fail();
        save(grant,initial.binding,now);oauth.committed(grant.refreshToken);stage='done';return ended('CONNECTED');
      }catch(error){let status=error.message==='SUPPORT_EMAIL_SEND_REVOKE_UNCONFIRMED'?'REVOKE_UNCONFIRMED':'FAILED';
        if(grant){if(error.committed){try{oauth.committed(grant.refreshToken);}catch(_){/* Never revoke a committed file. */}}
          else{try{await oauth.revokeUncommitted(grant.refreshToken);}catch(_){status='REVOKE_UNCONFIRMED';}}}
        stage='done';return ended(status);}
    }
    return denied();
  }};
}
async function listenSendInstaller(installer) {
  let active=0,stopping,resolveDone;const done=new Promise(resolve=>{resolveDone=resolve;});
  const server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000},async(req,res)=>{
    active++;let body='',result;
    try{for await(const part of req){body+=part.toString('utf8');if(Buffer.byteLength(body)>256)fail();}
      result=await installer.handle({method:req.method,url:req.url,headers:req.headers,body});
    }catch(_){result={status:400,headers,body:'<p>Connection request rejected.</p>'};}
    if(!res.destroyed){res.writeHead(result.status,result.headers);res.end(result.body,()=>{if(result.terminal)finish(result.terminal);});}
    else if(result.terminal)finish(result.terminal);active--;if(stopping&&active===0)resolveDone(stopping);
  });
  const timer=setTimeout(()=>finish('EXPIRED'),Math.max(1,installer.deadline-Date.now()));
  function finish(status){if(!stopping||status==='REVOKE_UNCONFIRMED')stopping=status;if(status!=='CONNECTED')installer.abort();clearTimeout(timer);server.close();server.closeAllConnections();if(active===0)resolveDone(stopping);}
  server.on('clientError',(_,socket)=>socket.destroy());
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(43873,'127.0.0.1',resolve);});}
  catch(_){clearTimeout(timer);server.close();fail();}
  return {address:server.address(),done,close:()=>finish('CLOSED')};
}
module.exports={HOST,ORIGIN,storeSendGrant,createSendInstaller,listenSendInstaller};
