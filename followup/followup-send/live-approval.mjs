// Actual in-process MCP/DeviceAgent/executor + production approval view/preload.
// Launching presents an approval card; no send occurs before its decision.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=process.env.REVIEW_WORKTREE;
const out=process.env.REVIEW_OUT;
const config=JSON.parse(fs.readFileSync(process.env.REVIEW_CONFIG,'utf8'));
if(!root||!out||!config.recipient||!config.body||!['imessage','whatsapp'].includes(config.app))throw Error('Explicit review configuration required');
fs.mkdirSync(out,{recursive:true});
const log=x=>{const line=JSON.stringify(x);fs.appendFileSync(path.join(out,'live-approval.ndjson'),line+'\n');console.log(line);};
const {DeviceAgent,loadPlugins,nodeProbes}=await import(pathToFileURL(path.join(root,'packages/device-core/dist/index.js')));
const {createDomoMcpServer,PROTOCOL_REVISION}=await import(pathToFileURL(path.join(root,'packages/mcp-server/dist/index.js')));
const {approvalViewModel}=await import(pathToFileURL(path.join(root,'apps/desktop/dist/viewModel.js')));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'latch-live-reviewed-'));
const policy={async decideIntent(intent){
 const [cap]=intent.capabilities;
 if(intent.capabilities.length!==1||cap.kind!=='message_send'||cap.app!==config.app||cap.recipient!==config.recipient||cap.bodyPreview!==config.body)return 'deny';
 const model=approvalViewModel(intent);
 const promptFile=path.join(out,'approval-private.json');
 const decisionFile=path.join(out,'decision-private.json');
 fs.writeFileSync(promptFile,JSON.stringify(model),{mode:0o600});
 log({event:'approval_pending',app:config.app,bodyLength:config.body.length});
 for(let i=0;i<1200;i++){
  if(fs.existsSync(decisionFile)){
   const choice=JSON.parse(fs.readFileSync(decisionFile,'utf8'));
   if(choice.id===model.intentId&&['deny','allow_once','always_allow'].includes(choice.decision)){
    log({event:'interactive_decision',decision:choice.decision});return choice.decision;
   }
  }
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 return 'deny';
}};
const device=new DeviceAgent(home,'Owner-authorized validation',policy,null,os.homedir(),null,loadPlugins([path.join(root,'vendor/plugins')]),null,nodeProbes({ownerHome:os.homedir(),helperPath:path.join(path.dirname(process.env.REVIEW_CONFIG),'host-permissions')}));
if(config.preflight){
 const realRun=device.executor.runAppleScript.bind(device.executor);
 device.executor.runAppleScript=async request=>{
  const guards=`
var realNativeFactory=nativeWhatsAppAdapter;
nativeWhatsAppAdapter=function(){
 var a=realNativeFactory();
 ['escape','paste','focus','clipboard'].forEach(function(name){var method=a[name];a[name]=function(){try{return method.apply(a,arguments);}catch(error){console.log('AX_REVIEW_NATIVE_ERROR '+name+' '+String(error));throw error;}};});
 var priorHeader=null, priorComposer=null; var snap=a.snapshot;
 a.snapshot=function(){
  var s;try{s=snap();}catch(error){console.log('AX_REVIEW_SNAPSHOT_ERROR '+String(error));throw error;}
  function byId(nodes,id){for(var i=0;i<nodes.length;i++){if(nodes[i].identifier===id)return nodes[i];var child=byId(nodes[i].children,id);if(child)return child;}return null;}
  var header=byId(s.roots,'NavigationBar_HeaderViewButton'), composer=byId(s.roots,'ChatBar_ComposerTextView');
  if(header && composer){console.log('AX_REVIEW_CONTINUITY '+JSON.stringify({headerSame:priorHeader? a.sameElement(priorHeader,header):null,composerSame:priorComposer? a.sameElement(priorComposer,composer):null}));if(!priorHeader){priorHeader=header;priorComposer=composer;}}
  var rows=[];
  function walk(n,d){ rows.push({id:n.identifier,role:n.role,enabled:n.enabled,valueKind:n.value===null?'null':n.value===''?'empty':/^[+0-9 ()\\-]+$/.test(n.value)?'phone-shaped':'text',depth:d});n.children.forEach(function(c){walk(c,d+1);}); }
  s.roots.forEach(function(n){walk(n,0);});
  console.log('AX_REVIEW '+JSON.stringify({frontmost:s.frontmost,focusedWindow:!!s.focusedWindow,focusedMain:s.focusedWindow&&s.roots.length? a.sameElement(s.focusedWindow,s.roots[0]):false,rows:rows}));
  return s;
 };
 ${config.preflight === 'draft' ? `var originalClipboard=a.clipboard; a.clipboard=function(body){console.log('AX_REVIEW_IDENTITY_CONFIRMED'); var owned=originalClipboard(body); var restore=owned.restore; owned.restore=function(){restore(); console.log('AX_REVIEW_CLIPBOARD_RESTORE_RETURNED');}; return owned;};` : `a.clipboard=function(){console.log('AX_REVIEW_IDENTITY_CONFIRMED');throw Error('REVIEW_STOP_BEFORE_COMPOSING');}; a.paste=function(){throw Error('REVIEW_SEND_DISABLED');};`}
 var originalPress=a.press;
 a.press=function(n){if(n.identifier==='ChatBar_SendButton'){console.log('AX_REVIEW_FINAL_SEND_STUB_REACHED');throw Error('REVIEW_SEND_DISABLED');}return originalPress(n);};
 return a;
};`;
  const result=await realRun({...request,script:request.script.replace(/catch \{\s*failure = attempted/, 'catch (reviewError) { console.log("AX_REVIEW_CONTROLLER_ERROR "+String(reviewError)); failure = attempted')+'\n'+guards});
  if(!result.running){fs.writeFileSync(path.join(out,'native-preflight-stderr.txt'),result.stderr,{mode:0o600});}
  return result;
 };
}
const server=createDomoMcpServer(device,{budgetMs:500});
const auth={agent_id:'pr541-final-ui-validation',agent_name:'PR 541 validation',scopes:['relay:call']};
let id=0;
async function call(name,args){
 const response=await server.fetch(new Request('http://mac/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':PROTOCOL_REVISION,'mcp-method':'tools/call','mcp-name':name},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':PROTOCOL_REVISION,'io.modelcontextprotocol/clientInfo':{name:'review-live',version:'2'},'io.modelcontextprotocol/clientCapabilities':{}}}})}),auth);
 const r=await response.json();return r.result?.content?.[0]?.text?JSON.parse(r.result.content[0].text):r;
}
try{
 const before=Date.now();
 let result=await call('plow_send_message',{app:config.app,recipient:config.recipient,body:config.body,goal:'User-authorized PR validation with the exact visible recipient and test body; do not retry'});
 const handle=result.handle;
 for(let i=0;result.status==='pending'&&i<720;i++){await new Promise(resolve=>setTimeout(resolve,250));result=await call('plow_get_result',{handle});}
 if(result.status==='ready')result=result.result;
 const report={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0,app:config.app,recipient:'[authorized test recipient; redacted]',realApp:true,realStore:true,liveRelay:false,approval:'interactive production renderer through test-only Electron window and local-file approval bridge',sendActionStubbed:Boolean(config.preflight),shippingDecoderVersion:'0.1.0',elapsedMs:Date.now()-before,status:result.status,reason:result.reason??null,hostGate:result.host_gate??null,sendAttempted:result.send_attempted??null,scriptExit:result.script_exit??null,rowPresent:typeof result.row?.rowid==='number',noRetry:true,decisions:device.audit.entries().filter(e=>e.event==='intent_decision').map(e=>({decision:e.decision,source:e.source})),sendStarts:device.audit.entries().filter(e=>e.event==='message_send_start').length,sendResults:device.audit.entries().filter(e=>e.event==='message_send_result').map(e=>({verified:e.verified,scriptExit:e.script_exit,rowPresent:typeof e.rowid==='number'}))};
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');log(report);
} catch(error){log({event:'driver_error',name:error.name});process.exitCode=1;}
finally{await server.close();}
