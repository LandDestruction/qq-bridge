// Legacy static guards need a responsibility-spanning source view after modularization.
// This reads CURRENT modules, never a saved baseline. Runtime tests execute actual factories.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const root=fileURLToPath(new URL('..',import.meta.url));
export function bridgeModuleManifest(){return JSON.parse(fs.readFileSync(path.join(root,'src/bridge/manifest.json'),'utf8'));}
export function installBridgeModules(context){
  for(const item of bridgeModuleManifest().modules){
    const source=fs.readFileSync(path.join(root,item.file),'utf8').replace(/^export /gm,'').replace(/^import .*$/gm,'');
    // Compile in the fixture realm, so fetch/process/timers and object prototypes stay isolated.
    vm.runInContext(`${source}\nglobalThis.${item.factory}=${item.factory};`,context,{filename:item.file});
  }
}
export function bridgeBootFiles(){
  const dir=path.join(root,'src/bridge/boot');
  if(!fs.existsSync(dir))return [];
  return fs.readdirSync(dir).filter(f=>f.endsWith('.js')).sort().map(f=>path.join(dir,f));
}
// D62: main() 的装配阶段拆到 src/bridge/boot/*.js。审计沙箱的 VM 会剥掉 import，
// 这些阶段函数必须像业务模块一样注入 context，否则 main() 一调用就 ReferenceError。
export function installBootModules(context){
  for(const file of bridgeBootFiles()){
    const source=fs.readFileSync(file,'utf8').replace(/^export /gm,'');
    vm.runInContext(source,context,{filename:file});
  }
}
export function readBridgeSources(){
  // 静态守卫的「职责跨越」搜索面：readBridgeSource()（bridge.js + boot 展开）+ boot/*.js + console/*.js 原文。
  // 为什么需要：④/D62 之后路由字面量搬进 console 模块、装配代码搬进 boot 模块，只搜 readBridgeSource()
  // 会漏掉真正落地的名字（表现为「测试红、代码对」）。只扩到这几个目录，不做任意文件包含。
  const dirs=[path.join(root,'src/bridge/boot'),path.join(root,'src/bridge/console')];
  const files=dirs.flatMap((dir)=>fs.existsSync(dir)?fs.readdirSync(dir).filter((f)=>f.endsWith('.js')).sort().map((f)=>path.join(dir,f)):[]);
  return [readBridgeSource(),...files.map((file)=>fs.readFileSync(file,'utf8'))].join('\n');
}
export function readBridgeSource(){
  const manifest=bridgeModuleManifest(),functions=new Map();
  for(const item of manifest.modules){
    // 统一换行再找标记：Windows 编辑器保存过的模块（message-format.js / media-input.js 等）是 CRLF，
    // 而标记要求 `...:start\n`，CRLF 下永远匹配不到 → 整批静态守卫假红（Missing function markers）。
    // 只归一化读入的副本，不改任何源文件，也不放宽断言（标记仍然必须存在）。
    const source=fs.readFileSync(path.join(root,item.file),'utf8').replace(/\r\n?/g,'\n');
    for(const name of item.functions){
      const start=`// @bridge-function ${name}:start\n`,end=`\n// @bridge-function ${name}:end`;
      if(!source.includes(start)||!source.includes(end))throw Error(`Missing function markers: ${name}`);
      const text=source.slice(source.indexOf(start)+start.length,source.indexOf(end));
      functions.set(name,text.replace(/\(0, deps\.(\w+)\)(?=\s*(?:\?\.)?\()/g,'$1').replace(/\bdeps\.(\w+)/g,'$1'));
    }
  }
  const expandRoutes=(text)=>text.replace(/\/\/ @bridge-routes (\w+)\n[\s\S]*?\/\/ @bridge-routes \1:end/g,(_match,name)=>{
    const fn=functions.get(name);if(!fn)throw Error(`Missing route ${name}`);
    return fn.slice(fn.indexOf('{')+1,fn.lastIndexOf('return false;')).replace(/\brequest\./g,'').replace(/return true; \/\* @bridge-handled \*\//g,'return;');
  });
  functions.set('startConsoleServer',expandRoutes(functions.get('startConsoleServer')));
  // 修屎山第一刀：59 个路由分派块从 startConsoleServer 提取到 console-server.js 模块级
  // dispatchRoutesA/B/C。静态守卫继续展开这几段的 @bridge-routes 标记，路由字面量仍能落地到视图。
  const consoleServerSrc=fs.readFileSync(path.join(root,'src/bridge/console-server.js'),'utf8');
  const routeView=['dispatchRoutesA','dispatchRoutesB','dispatchRoutesC'].map((seg)=>{
    const start=consoleServerSrc.indexOf(`async function ${seg}(`);
    if(start<0)return '';
    const brace=consoleServerSrc.indexOf('{',start);
    let depth=0,end=-1;
    for(let i=brace;i<consoleServerSrc.length;i++){
      if(consoleServerSrc[i]==='{')depth++;
      else if(consoleServerSrc[i]==='}'){depth--;if(depth===0){end=i+1;break;}}
    }
    if(end<0)return '';
    return expandRoutes(consoleServerSrc.slice(brace+1,end-1));
  }).join('\n');
  // 修屎山第二刀：handleIncoming 拆出的模块级函数（archiveIncomingFiles/handleSlashCommands/
  // handleReserved2Wake/handleSocialMode）里的字符串，静态守卫还要能看见（黑名单过闸/引用视频
  // 分流/迟到补发 claim）。把 incoming-runtime.js 原文去 deps 前缀纳入视图。
  const incomingSrc=fs.readFileSync(path.join(root,'src/bridge/incoming-runtime.js'),'utf8')
    .replace(/^export /gm,'')
    .replace(/\(0, deps\.(\w+)\)(?=\s*(?:\.)?\()/g,'$1')
    .replace(/\bdeps\.(\w+)/g,'$1');
  // 修屎山第九刀起：mux-runtime.js 提取到模块级的函数（handleTurnEnd/handleTurnError 等）含
  // preferMalformed/noteNoKey 等字面量，静态守卫（test-malformed-retry/test-context-budget）还要能看见。
  const muxSrc=fs.readFileSync(path.join(root,'src/bridge/mux-runtime.js'),'utf8')
    .replace(/^export /gm,'')
    .replace(/\(0, deps\.(\w+)\)(?=\s*(?:\.)?\()/g,'$1')
    .replace(/\bdeps\.(\w+)/g,'$1');
  // 修屎山第三刀起：console/*.js 里提取到模块级的函数（dispatchDshRoutes 等）含路由字面量，
  // 静态守卫（test-tts-ext 找 /api/observe/config 等）还要能看见。把 console 目录原文去 deps 前缀纳入视图。
  const consoleDir=path.join(root,'src/bridge/console');
  const consoleSrc=(fs.existsSync(consoleDir)?fs.readdirSync(consoleDir).filter((f)=>f.endsWith('.js')).sort().map((f)=>path.join(consoleDir,f)):[])
    .map((file)=>fs.readFileSync(file,'utf8').replace(/^export /gm,'').replace(/\(0, deps\.(\w+)\)(?=\s*(?:\.)?\()/g,'$1').replace(/\bdeps\.(\w+)/g,'$1'))
    .join('\n');
  const expand=(text)=>text.replace(/\/\/ @bridge-function (\w+) from ([\w/-]+)/g,(_match,name)=>name.startsWith('handleConsole')?'':functions.get(name)??(()=>{throw Error(`Unknown function ${name}`);})());
  const bridge=fs.readFileSync(path.join(root,'src/bridge.js'),'utf8')
    .replace(/^\s*const \{ [^\n]+ \} = create\w+\((?:sharedBindings|runtimeBindings)\);/gm,'');
  // 静态守卫要能看见搬进 boot 阶段的装配代码（按同一套 @bridge-function 标记展开）。
  const boot=bridgeBootFiles().map((file)=>expand(fs.readFileSync(file,'utf8')).replace(/^export /gm,'')).join('\n');
  return boot?`${expand(bridge)}\n${boot}\n${routeView}\n${incomingSrc}\n${muxSrc}\n${consoleSrc}`:`${expand(bridge)}\n${routeView}\n${incomingSrc}\n${muxSrc}\n${consoleSrc}`;
}
