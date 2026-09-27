// UI host only; the actual MCP/DeviceAgent process runs under the existing
// authorized host. The production preload/renderer returns one decision.
import {app,BrowserWindow,ipcMain} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
const root=process.env.REVIEW_WORKTREE;
const out=process.env.REVIEW_OUT;
app.setPath('userData',path.join(out,'electron-profile'));
app.setName('Latch live validation');
app.whenReady().then(async()=>{
let model;
for(let i=0;i<1200;i++){
 const prompt=path.join(out,'approval-private.json');
 if(fs.existsSync(prompt)){model=JSON.parse(fs.readFileSync(prompt,'utf8'));break;}
 await new Promise(resolve=>setTimeout(resolve,150));
}
if(!model)throw Error('No pending approval');
const win=new BrowserWindow({width:460,height:560,resizable:false,fullscreenable:false,title:'Latch live validation — approved test',webPreferences:{preload:path.join(root,'apps/desktop/dist/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
let settled=false;
const finish=decision=>{
 if(settled)return;settled=true;
 fs.writeFileSync(path.join(out,'decision-private.json'),JSON.stringify({id:model.intentId,decision}),{mode:0o600});
 console.log(JSON.stringify({event:'decision',decision}));
 app.quit();
};
ipcMain.handle('approval:get',()=>({kind:'intent',view:model,suggesting:false}));
ipcMain.handle('approval:ready',()=>console.log(JSON.stringify({event:'approval_ready'})));
ipcMain.on('approval:decide',(_event,id,decision)=>{if(id===model.intentId&&['deny','allow_once','always_allow'].includes(decision))finish(decision);});
win.on('closed',()=>finish('deny'));
await win.loadFile(path.join(root,'apps/desktop/dist/renderer/approval.html'));

}).catch(error=>{console.error(error);app.exit(1);});
