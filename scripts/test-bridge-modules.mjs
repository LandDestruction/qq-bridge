// Refactor-specific boundary regressions. Uses fake dependencies and in-memory queues only.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { bridgeModuleManifest, readBridgeSource } from './bridge-source.mjs';
import { createPeakRuntime } from '../src/bridge/peak-runtime.js';
import { createOutboundText } from '../src/bridge/outbound-text.js';
import { createOutboundPolicy } from '../src/bridge/outbound-policy.js';

test('every extracted module imports as ESM and constructs without touching uninitialized live bindings',async()=>{
  const manifest=bridgeModuleManifest();
  for(const item of manifest.modules){
    const deps={};for(const name of item.dependencies)Object.defineProperty(deps,name,{get(){throw Error(`eager access: ${item.file}:${name}`);}});
    const module=await import(new URL('../'+item.file,import.meta.url));
    assert.equal(typeof module[item.factory],'function',item.file);
    const service=module[item.factory](deps);
    assert.deepEqual(Object.keys(service),item.functions,item.file);
    assert(Object.values(service).every(fn=>typeof fn==='function'),item.file);
  }
});
test('a config replacement is visible to an existing module instance',()=>{
  let cfg={socialV2:{peakPause:{enabled:false,schedule:false,days:[1]}}};
  const service=createPeakRuntime({get cfg(){return cfg;}});
  assert.equal(service.peakCfg().enabled,false);
  cfg={socialV2:{peakPause:{enabled:true,schedule:true,days:[2,3]}}};
  assert.equal(service.peakCfg().enabled,true);assert.deepEqual(service.peakCfg().days,[2,3]);
});
test('separate text and v2 send modules preserve one live, ordered send chain',async()=>{
  let chain=Promise.resolve(),release,writes=0;const calls=[],barrier=new Promise(r=>{release=r;});
  const deps={
    get sendChain(){return chain;},set sendChain(value){writes++;chain=value;},
    cfg:{sendDelayMs:0},state:{sessions:{}},sessionPolicy:()=> 'fixture-policy',isSessionAllowedInCurrentMode:()=>true,
    KNOWN_AGENT_TOKENS:new Set(),lastSendFailed:new Map(),personaGuidePending:new Map(),
    assertIdentitySendAllowed:()=>{},
    captureSendGuard:()=>()=>{},splitForQQ:s=>[s],escapeCqText:s=>s,text:s=>s,withTimeout:p=>p,sleep:async()=>{},log:()=>{},
    bot:{async sendGroupMessage(_id,text){calls.push(text);await barrier;}},
    reserveSendSlot:async()=>{},
    async onebotSend(_kind,_id,text){calls.push(text);return{message_id:7};},
  };
  const first=createOutboundText(deps).sendToQQ('group:456','first');
  const second=createOutboundPolicy(deps).sendMessagesV2('group:456',['second'],[],null);
  await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['first']);
  release();await Promise.all([first,second]);assert.deepEqual(calls,['first','second']);assert(writes>=2);
});
test('static guard view expands current endpoint modules and retains nested boolean returns and normal slice arguments',()=>{
  const text=readBridgeSource();
  assert(text.includes("url.pathname === '/api/status'"));assert(text.includes("url.pathname === '/api/socialV2/wait'"));
  assert(!text.includes('if (await handleConsole'));assert(text.includes('body.slice(0, LOG_LINE_MAX)'));
  const server=fs.readFileSync(new URL('../src/bridge/console-server.js',import.meta.url),'utf8');
  assert(server.indexOf("!tokenMatches")<server.indexOf('dispatchConsoleRoutes(deps'),'auth must remain before endpoint dispatch');
});
test('每个 boot 阶段/工具模块的导出名都在装配根 import 过（真进程启动才暴露的漏 import）',()=>{
  // 这条是为 ⑦ 那次事故加的：VM 门禁把 boot 阶段当全局注入，
  // 于是 bridge.js 漏 import 也全绿，只有真实 ESM 启动会在 main() 末尾 ReferenceError。
  const root = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const missing = [];
  for (const dir of ['boot', 'console']) {
    const abs = new URL(`../src/bridge/${dir}/`, import.meta.url);
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(new URL(name, abs), 'utf8');
      const exported = [...src.matchAll(/^exports+(?:asyncs+)?functions+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
      for (const fn of exported) {
        const hit = new RegExp('(^|[^A-Za-z0-9_$])' + fn + '([^A-Za-z0-9_$]|$)').test(root);
        if (!hit) missing.push(dir + '/' + name + ' → ' + fn);
      }
    }
  }
  assert.deepEqual(missing, [], '这些导出名没有出现在 src/bridge.js 里（漏 import）: ' + missing.join(', '));
});
test('a token changed inside an endpoint updates the central gate, and unmatched routes still return 404',async()=>{
  const h=await bridgeHarness(),server=h.startConsoleServer();
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  const request=(route,token,body)=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method:body?'POST':'GET',headers:{'x-console-token':token,'content-type':'application/json'}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>{text+=part;});res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));
    });req.on('error',reject);req.setTimeout(2000,()=>req.destroy(Error('fixture timeout')));req.end(body?JSON.stringify(body):undefined);
  });
  try{
    const token='fixture-refactored-console-token';
    assert.equal((await request('/api/console/token','fixture-console-token',{token})).status,200);
    assert.equal((await request('/api/socialV2/activity','fixture-console-token')).status,401);
    assert.equal((await request('/api/socialV2/activity',token)).status,200);
    assert.equal((await request('/api/not-a-real-endpoint',token)).status,404);
    assert.equal(h.calls.sent.length,0);
  }finally{await new Promise(resolve=>server.close(resolve));await h.close();}
});

// 反向覆盖：console-server.js 里调用的每一个 deps.handleConsoleXxx 都必须写进 manifest 的
// dependencies。之前只按 manifest 造 stub（正向），漏声明时运行时没事、测试也全绿，
// 接线台账和代码却能长期不一致（第 4 批验收就是这么发现缺 handleConsoleLibraryPurchases 的）。
test('console-server 调用的 handleConsole* 全都在 manifest dependencies 里（反向覆盖）',async()=>{
  const fs=await import('node:fs');
  const path=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const manifest=bridgeModuleManifest();
  const item=manifest.modules.find((m)=>m.file==='src/bridge/console-server.js');
  assert(item,'manifest 里应有 console-server 模块');
  const src=fs.readFileSync(path.join(root,'src/bridge/console-server.js'),'utf8');
  const used=new Set([...src.matchAll(/\(0, deps\.(handleConsole[A-Za-z0-9_]+)\)/g)].map((m)=>m[1]));
  assert(used.size>0,'console-server 里应能扫到 deps.handleConsole* 调用');
  const declared=new Set(item.dependencies);
  const missing=[...used].filter((name)=>!declared.has(name));
  assert.deepEqual(missing,[],`manifest console-server dependencies 缺：${missing.join(', ')}`);
});
