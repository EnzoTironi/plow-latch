import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.REVIEW_READS_WORKTREE;
const {DeviceAgent,loadPlugins}=await import(pathToFileURL(path.join(root,'packages/device-core/dist/index.js')));
const {createDomoMcpServer,PROTOCOL_REVISION}=await import(pathToFileURL(path.join(root,'packages/mcp-server/dist/index.js')));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'latch-live-reads-'));
const pluginRoot=path.join(home,'test-plugins'),dir=path.join(pluginRoot,'messages');
const bin=path.join(dir,'runtime',process.arch,'bin','plow-messages');
fs.mkdirSync(path.dirname(bin),{recursive:true});
for(const file of ['latch-plugin.json','skill.md'])fs.copyFileSync(path.join(root,'apps/desktop/plugins/messages',file),path.join(dir,file));
// Explicit source-build test override in a throwaway plugin directory. This
// does not change or validate the shipping v0.1.0 manifest/archive pin.
fs.copyFileSync(process.env.REVIEW_CLI_BINARY,bin);fs.chmodSync(bin,0o755);
let decisions=0;
const device=new DeviceAgent(home,'Read review', {async decideIntent(){decisions++;return 'allow_once';}},null,os.homedir(),null,loadPlugins([pluginRoot]));
const server=createDomoMcpServer(device,{budgetMs:500});
const auth={agent_id:'pr540-read-test',agent_name:'Read review',scopes:['relay:call']};let id=0;
async function call(name,args){
 const response=await server.fetch(new Request('http://mac/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':PROTOCOL_REVISION,'mcp-method':'tools/call','mcp-name':name},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':PROTOCOL_REVISION,'io.modelcontextprotocol/clientInfo':{name:'review',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}),auth);
 const r=await response.json();return r.result?.content?.[0]?.text?JSON.parse(r.result.content[0].text):r;
}
async function run(args){let r=await call('plow_run_command',args);const handle=r.handle;for(let i=0;r.status==='pending'&&i<120;i++){await new Promise(r=>setTimeout(r,250));r=await call('plow_get_result',{handle});}return r.status==='ready'?r.result:r;}
const report={latch:'0171b62615d8d981411aa6ffe827741014eac632',cli:'493614d4398c04754e6a5006f0eb78de16947b87',sourceBinaryOverride:true,shippingPinValidated:false,realStores:true,privateOutputRedacted:true,results:[]};
try{
 for(const app of ['imessage','whatsapp']){
  const readPath=app==='imessage'?path.join(os.homedir(),'Library/Messages'):path.join(os.homedir(),'Library/Group Containers/group.net.whatsapp.WhatsApp.shared');
  const r=await run({argv:['plow-messages','--app',app,'chats','--limit','3'],read_paths:[readPath],goal:'Read-only PR validation on owner-authorized archives'});
  const text=r.output??r.stdout??''; let rows=[];try{rows=String(text).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
  report.results.push({app,status:r.status,exitCode:r.exit_code??null,keys:Object.keys(r),jsonRows:rows.length,shape:rows.every(x=>'chat_id'in x&&'guid'in x)});
 }
 const before=decisions;const r=await run({argv:['plow-messages','chats','--store','/tmp/other.sqlite']});
 report.overrideRejectedBeforeApproval=decisions===before&&Boolean(r.error);
 // Remove only this harness-created staged copy. The already-loaded plugin
 // must fail closed instead of finding a command elsewhere on PATH.
 fs.renameSync(bin,bin+'.held-for-negative-control');
 const r2=await run({argv:['plow-messages','--app','whatsapp','chats'],read_paths:[path.join(os.homedir(),'Library/Group Containers/group.net.whatsapp.WhatsApp.shared')]});
 report.missingBinary={status:r2.status,exitCode:r2.exit_code??null,errorPresent:Boolean(r2.error),keys:Object.keys(r2)};
 fs.writeFileSync('../live/read-dispatch-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await server.close();}
