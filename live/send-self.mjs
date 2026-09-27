// Live, user-authorized iMessage self-test. No relay or network test server.
// Uses the built PR's actual MCP/DeviceAgent/executor/SQLite implementation.
// A disposable policy home grants only these two exact test bodies to self.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = process.env.REVIEW_WORKTREE;
const { DeviceAgent } = await import(pathToFileURL(path.join(root,'packages/device-core/dist/index.js')));
const { createDomoMcpServer, PROTOCOL_REVISION } = await import(pathToFileURL(path.join(root,'packages/mcp-server/dist/index.js')));
const recipient = process.env.REVIEW_RECIPIENT;
if (!recipient) throw new Error('An explicitly verified self recipient is required');
const home = fs.mkdtempSync(path.join(os.tmpdir(),'latch-live-self-'));
const bodies = ['Latch PR #541 self-test A — 2026-09-27. One approved message.', 'Latch PR #541 self-test B — 2026-09-27. Same recipient, different text.'];
let cards = 0;
const policy = { async decideIntent(intent) {
  cards++;
  const [cap] = intent.capabilities;
  if (intent.capabilities.length !== 1 || cap.kind !== 'message_send' || cap.app !== 'imessage' || cap.recipient !== recipient || !bodies.includes(cap.bodyPreview)) return 'deny';
  return 'always_allow';
}};
const device = new DeviceAgent(home,'Live self-test Mac',policy,null,os.homedir());
const server = createDomoMcpServer(device,{budgetMs:500});
const auth = {agent_id:'pr-541-self-test',agent_name:'PR 541 self-test',scopes:['relay:call']};
let requestId=0;
const report = {commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim().length>0, realApp:true, realStore:true, relay:'in-process MCP envelope; no live relay', approval:'preauthorized test-only delegate; disposable rule store',recipient:'[self; redacted]', results:[]};
async function call(name,args) {
 const params={name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':PROTOCOL_REVISION,'io.modelcontextprotocol/clientInfo':{name:'review-live',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}};
 const response=await server.fetch(new Request('http://mac/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':PROTOCOL_REVISION,'mcp-method':'tools/call','mcp-name':name},body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method:'tools/call',params})}),auth);
 const json=await response.json(); const text=json.result?.content?.[0]?.text;
 return text ? JSON.parse(text) : json;
}
try {
 for (let i=0;i<bodies.length;i++) {
  const start=Date.now();
  let result=await call('plow_send_message',{app:'imessage',recipient,body:bodies[i],goal:'User-authorized validation: send this clearly marked test only to the signed-in owner'});
  const pending=result.status==='pending';
  if(pending) { const handle=result.handle; while(result.status==='pending' && Date.now()-start<90000) { await new Promise(r=>setTimeout(r,250)); result=await call('plow_get_result',{handle}); } if(result.status==='ready')result=result.result; }
  const safe={test:i+1,status:result.status,deferred:pending,elapsedMs:Date.now()-start,verifiedRowPresent:typeof result.row?.rowid==='number',scriptExit:result.script_exit??null,reason:result.reason??null,hostGate:result.host_gate??null};
  report.results.push(safe); console.log(JSON.stringify(safe));
  if(result.status!=='verified') {report.stoppedWithoutRetry=true; break;}
 }
 const wrong=await call('plow_send_message',{app:'imessage',recipient:'different-recipient@example.com',body:'This must be denied without an app send.'});
 report.otherRecipientDenied=wrong.status==='denied';
 report.approvalDecisions=cards;
 const events=device.audit.entries();
 report.decisions=events.filter(e=>e.event==='intent_decision').map(e=>({decision:e.decision,source:e.source}));
 report.messageResults=events.filter(e=>e.event==='message_send_result').map(e=>({verified:e.verified,scriptExit:e.script_exit,rowPresent:typeof e.rowid==='number'}));
 const sql='select m.text,m.is_sent,m.error,count(*) as n from message m join handle h on h.ROWID=m.handle_id where m.is_from_me=1 and h.id='+"'"+recipient.replaceAll("'","''")+"'"+' and m.text in ('+bodies.map(b=>"'"+b.replaceAll("'","''")+"'").join(',')+') group by m.text,m.is_sent,m.error;';
 const rows=JSON.parse(execFileSync('/usr/bin/sqlite3',['-readonly','-json',path.join(os.homedir(),'Library/Messages/chat.db'),sql],{encoding:'utf8'})||'[]');
 report.independentStoreCheck=bodies.map((body,i)=>({test:i+1,rows:rows.filter(r=>r.text===body).reduce((sum,r)=>sum+r.n,0),sentRows:rows.filter(r=>r.text===body&&r.is_sent===1&&r.error===0).reduce((sum,r)=>sum+r.n,0)}));
 fs.writeFileSync('../live/send-results.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
} finally { await server.close(); }
