'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const {createPreview}=require('../scripts/preview.cjs');
const OUTPUT=process.env.MDW_BROWSER_OUTPUT||path.join(require('node:os').tmpdir(),'mdw-browser-artifacts');
const entities=['tasks','events','papers','academic','fitness','life'];
let checks=0;
function pass(message){checks++;console.log(`PASS ${message}`);}
async function visible(locator){await locator.waitFor({state:'visible'});}
async function fillRecord(page,entity,title,date='2028-02-29'){
  await page.locator(`[data-create="${entity}"]`).click();
  const f=page.locator('#record-form');
  await f.locator('[name=title]').fill(title);await f.locator('[name=date]').fill(date);
  await f.locator('[name=note]').fill('仅用于自动化测试的虚构备注。');
  if(entity==='papers'){await f.locator('[name=goal]').fill('虚构研究目标');await f.locator('[name=stage]').selectOption('2');await f.locator('[name=deadline]').fill('2028-03-10');}
  if(entity==='academic')await f.locator('[name=location]').fill('虚构会场');
  if(entity==='fitness')await f.locator('[name=duration]').fill('25');
  await f.locator('[type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
}
function recordRow(page,entity,title){return page.locator(`#${entity}-list .row`).filter({has:page.getByRole('heading',{name:title,exact:true})});}
function backupFile(records){return {name:'virtual-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schemaVersion:1,records}))};}
async function backupRegression(origin,browser){
  const context=await browser.newContext({viewport:{width:1100,height:900},acceptDownloads:true});
  const errors=[],external=[];
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(origin+'/private/?mode=demo');await visible(page.locator('#workspace'));
    const shared=[{id:'shared-module-id',entity:'tasks',title:'虚构同编号任务',date:'2028-03-02'},{id:'shared-module-id',entity:'life',title:'虚构同编号生活',date:'2028-03-02'}];
    await page.locator('#import-file').setInputFiles(backupFile(shared));await visible(page.locator('#restore-dialog'));assert.match(await page.locator('#restore-summary').innerText(),/2 条/);await page.locator('#confirm-restore').click();await page.locator('#restore-dialog').waitFor({state:'hidden'});
    await visible(recordRow(page,'tasks','虚构同编号任务'));await visible(recordRow(page,'life','虚构同编号生活'));
    page.once('dialog',dialog=>dialog.accept());await recordRow(page,'tasks','虚构同编号任务').getByRole('button',{name:'删除',exact:true}).click();await recordRow(page,'tasks','虚构同编号任务').waitFor({state:'detached'});await visible(recordRow(page,'life','虚构同编号生活'));
    pass('备份跨模块同 ID 可恢复，删除任务不影响同 ID 生活记录');
    await page.locator('#import-file').setInputFiles(backupFile([shared[1],{id:'another-id',entity:'tasks',title:'虚构不能部分导入',date:'2028-03-02'}]));await visible(page.locator('#restore-dialog'));await page.locator('#confirm-restore').click();await page.waitForFunction(()=>document.getElementById('restore-error').textContent.includes('同模块已有编号'));assert.equal(await recordRow(page,'tasks','虚构不能部分导入').count(),0);await page.locator('#cancel-restore').click();
    pass('同模块同 ID 冲突原子拒绝，不影响跨模块合法编号');

    await page.evaluate(()=>{const original=File.prototype.text;window.__fileReads=0;File.prototype.text=function(){window.__fileReads++;return original.call(this)}});
    const limit=8*1024*1024,base=Buffer.from(JSON.stringify({schemaVersion:1,records:[]}));
    await page.locator('#import-file').setInputFiles({name:'virtual-exact-8MiB.json',mimeType:'application/json',buffer:Buffer.concat([base,Buffer.alloc(limit-base.length,32)])});await visible(page.locator('#restore-dialog'));assert.match(await page.locator('#restore-summary').innerText(),/0 条/);await page.locator('#cancel-restore').click();assert.equal(await page.evaluate(()=>window.__fileReads),1);
    await page.locator('#import-file').setInputFiles({name:'virtual-too-large.json',mimeType:'application/json',buffer:Buffer.alloc(limit+1,32)});await page.waitForFunction(()=>document.getElementById('status').textContent.includes('8 MiB'));assert.equal(await page.evaluate(()=>window.__fileReads),1);assert.equal(await page.locator('#restore-dialog').isVisible(),false);
    pass('导入 8 MiB 恰好可解析预览，超 1 字节在读取前拒绝');

    const exportedPage=await context.newPage();exportedPage.on('pageerror',error=>errors.push(error.message));
    await exportedPage.route('**/private/provider.js',route=>route.fulfill({contentType:'text/javascript',body:`export async function createProvider(){return {mode:'cloud',async getSession(){return {authenticated:true}},async signIn(){},async signOut(){},async request(action){if(action==='list')return [];if(action==='export')return window.__backupPayload;throw new Error('unsupported')}}}`}));
    await exportedPage.goto(origin+'/private/');await visible(exportedPage.locator('#workspace'));
    await exportedPage.evaluate(()=>{window.__backupPayload={schemaVersion:1,records:Array.from({length:900},(_,i)=>({id:'oversize-'+i,entity:'tasks',title:'虚构体积测试',date:'2028-03-02',note:'文'.repeat(2000)}))}});
    let downloads=0;exportedPage.on('download',()=>downloads++);await exportedPage.locator('#export').click();await exportedPage.waitForFunction(()=>document.getElementById('status').textContent.includes('超过 4 MiB'));assert.equal(downloads,0);
    await exportedPage.evaluate(()=>{window.__backupPayload={schemaVersion:1,records:[{id:'normal',entity:'tasks',title:'虚构正常导出',date:'2028-03-02',note:'仅虚构'}]}});
    const promise=exportedPage.waitForEvent('download');await exportedPage.locator('#export').click();const downloaded=await promise;const stream=await downloaded.createReadStream();let contents='';for await(const chunk of stream)contents+=chunk;
    assert.equal(JSON.parse(contents).records[0].title,'虚构正常导出');assert.equal(Buffer.byteLength(contents,'utf8')<limit,true);
    pass('本地模拟云导出超 4 MiB 明确失败不下载，普通导出成功（非真实云验证）');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);pass('备份重点回归无 pageerror、无外网请求');
  }finally{await context.close();}
}
async function main(){
  await fs.mkdir(OUTPUT,{recursive:true});
  const server=createPreview();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    if(process.env.MDW_BROWSER_FOCUS==='backup'){
      await backupRegression(origin,browser);
      console.log(`Focused backup browser checks passed: ${checks}. No cloud resources were used.`);
      return;
    }
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
    const page=await context.newPage(),errors=[],external=[];
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});

    await page.goto(origin+'/dashboard.html');await visible(page.locator('#task-list label').first());
    assert.equal(await page.locator('main section').count(),6);
    const original=await page.locator('#task-list input').first().isChecked();
    await page.locator('#task-list input').first().click();assert.notEqual(await page.locator('#task-list input').first().isChecked(),original);
    await page.reload();assert.equal(await page.locator('#task-list input').first().isChecked(),original);
    pass('旧 dashboard 六模块与演示刷新恢复仍正常');

    const disabledConfig=route=>route.fulfill({contentType:'text/javascript',body:'export default Object.freeze({enabled:false,environmentId:"",region:"ap-shanghai",functionName:"mdwPrivateApi"});'});
    await page.route('**/private/config.public.js',disabledConfig);
    await page.goto(origin+'/private/');await visible(page.locator('#locked-panel'));
    assert.equal(await page.locator('#workspace').isVisible(),false);
    assert.equal(await page.locator('#login-panel').isVisible(),false);
    assert.equal(external.length,0);
    pass('未配置私人入口默认锁定，无演示回退或外网请求');
    await page.unroute('**/private/config.public.js',disabledConfig);

    await page.goto(origin+'/private/?mode=demo');await visible(page.locator('#workspace'));
    assert.match(await page.locator('#mode-notice').innerText(),/虚构/);
    await page.locator('details').evaluate(node=>node.open=true);
    for(const entity of entities){
      const title=`虚构验收-${entity}`;
      await fillRecord(page,entity,title);let row=recordRow(page,entity,title);await visible(row);
      await row.getByRole('button',{name:'编辑',exact:true}).click();
      await page.locator('#record-form [name=title]').fill(title+'-修改');
      await page.locator('#record-form [type=submit]').click();await page.locator('#editor').waitFor({state:'hidden'});
      row=recordRow(page,entity,title+'-修改');await visible(row);
      if(entity!=='papers'){
        await row.getByRole('button',{name:entity==='fitness'?'完成打卡':'标记完成',exact:true}).click();
        await visible(row.getByRole('button',{name:'标记未完成',exact:true}));
      }else assert.equal(await row.locator('progress').getAttribute('value'),'50');
      page.once('dialog',dialog=>dialog.accept());await row.getByRole('button',{name:'删除',exact:true}).click();await row.waitFor({state:'detached'});
      pass(`${entity} 真实 Chromium 新增/读取/编辑/完成或进度/删除`);
    }

    const current=(await page.locator('#month-label').innerText()).match(/\d+/g).map(Number);
    const delta=(2028-current[0])*12+2-current[1];
    for(let i=0;i<Math.abs(delta);i++)await page.locator(delta>0?'#next-month':'#prev-month').click();
    assert.equal(await page.locator('#month-label').innerText(),'2028 年 2 月');
    assert.equal(await page.locator('#days button').count(),29);
    await page.locator('#days button').filter({hasText:/^29$/}).click();
    assert.match(await page.locator('#agenda-label').innerText(),/2028-02-29/);
    pass('日历解除演示年份限制，2028 闰年与日期选择通过');

    const seedTask=page.locator('#tasks-list .row').first();
    await seedTask.getByRole('button',{name:'标记完成',exact:true}).click();
    await page.locator('#task-filter').selectOption('done');assert.equal(await page.locator('#tasks-list .row').count(),1);
    await page.locator('#task-filter').selectOption('open');assert.equal(await page.locator('#tasks-list .row').count(),0);
    await page.locator('#task-filter').selectOption('all');await page.locator('#task-search').fill('不存在的虚构查询');assert.equal(await page.locator('#tasks-list .row').count(),0);await page.locator('#task-search').fill('');
    pass('任务完成筛选、空列表和搜索通过');

    const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;
    const stream=await download.createReadStream();let text='';for await(const chunk of stream)text+=chunk;
    const exported=JSON.parse(text);assert.equal(exported.schemaVersion,1);assert.equal(exported.records.length,6);
    assert.doesNotMatch(text,/password|access_token|refresh_token|owner_id|service_role/);
    await page.locator('#import-file').setInputFiles(backupFile(exported.records));await visible(page.locator('#restore-dialog'));assert.match(await page.locator('#restore-summary').innerText(),/6 条/);
    await page.locator('#confirm-restore').click();await visible(page.locator('#restore-error'));assert.match(await page.locator('#restore-error').innerText(),/已有编号/);await page.locator('#cancel-restore').click();
    const restored={id:'browser-restore',entity:'life',title:'虚构恢复事项',date:'2028-03-01'};
    await page.locator('#import-file').setInputFiles(backupFile([restored]));await visible(page.locator('#restore-dialog'));await page.locator('#confirm-restore').click();await page.locator('#restore-dialog').waitFor({state:'hidden'});await visible(recordRow(page,'life','虚构恢复事项'));
    await page.locator('#import-file').setInputFiles(backupFile([{...restored,id:'malicious-record',owner_id:'another-user'}]));await page.waitForFunction(()=>document.getElementById('status').textContent.includes('不允许恢复'));assert.equal(await page.locator('#restore-dialog').isVisible(),false);
    pass('JSON 下载、恢复预览、重复原子拒绝、有效导入、归属字段注入拒绝');

    await page.reload();await visible(page.locator('#workspace'));assert.equal(await recordRow(page,'life','虚构恢复事项').count(),0);
    const overflowing=()=>document.documentElement.scrollWidth>window.innerWidth;
    assert.equal(await page.evaluate(overflowing),false);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(OUTPUT,'desktop-workspace.png'),fullPage:true});
    await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(overflowing),false);
    await fillRecord(page,'tasks','虚构手机宽度验收');await visible(recordRow(page,'tasks','虚构手机宽度验收'));
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(OUTPUT,'mobile-workspace.png'),fullPage:true});
    pass('1440 桌面和 375 手机模拟宽度无横向溢出，移动表单可用');
    assert.equal(external.length,0);assert.deepEqual(errors,[]);
    pass('演示全程无外网请求、无 pageerror；刷新不保留演示输入');

    // This is a controlled local provider double, not a real cloud login/API test.
    const mock=await context.newPage(),mockErrors=[];mock.on('pageerror',error=>mockErrors.push(error.message));
    await mock.route('**/private/provider.js',route=>route.fulfill({contentType:'text/javascript',body:`
      let session=false,offline=false,rows=[];const receipts=new Map();window.__mockActions=[];window.__mockImportIds=[];
      export async function createProvider(){return {mode:'cloud',async getSession(){return session?{authenticated:true}:null},async signIn(){session=true;offline=false},async signOut(){session=false},async request(action,payload){window.__mockActions.push(action);if(offline)throw Object.assign(new Error('模拟网络中断，未保存。'),{code:'NETWORK'});if(action==='list')return rows.filter(row=>row.entity===payload.entity);if(action==='import'){window.__mockImportIds.push(payload.requestId);if(window.__mockImportConflict)throw Object.assign(new Error('模拟编号冲突，整批未新增。'),{code:'CONFLICT'});if(receipts.has(payload.requestId))return {...receipts.get(payload.requestId),replayed:true};rows.push(...payload.backup.records.map(row=>({...row,version:1})));const result={count:payload.backup.records.length,replayed:false};receipts.set(payload.requestId,result);throw Object.assign(new Error('模拟服务已提交但响应丢失，请在此预览重试。'),{code:'NETWORK'});}if(action==='create'){if(Object.hasOwn(payload,'version'))throw new Error('create payload must not include version');offline=true;throw Object.assign(new Error('模拟网络中断，未保存。'),{code:'NETWORK'})}throw new Error('unsupported')}}}
    `}));
    await mock.goto(origin+'/private/');await visible(mock.locator('#login-panel'));
    await mock.locator('#username').fill('fictional-test');await mock.locator('#password').fill('fictional-browser-test');await mock.locator('#login-form [type=submit]').click();await visible(mock.locator('#workspace'));
    await mock.locator('#import-file').setInputFiles(backupFile(Array.from({length:41},(_,i)=>({id:'cloud-too-many-'+i,entity:'tasks',title:'虚构条数上限',date:'2028-03-02'}))));await mock.waitForFunction(()=>document.getElementById('status').textContent.includes('最多恢复 40 条'));assert.equal(await mock.locator('#restore-dialog').isVisible(),false);assert.equal(await mock.evaluate(()=>window.__mockActions.includes('import')),false);
    await mock.locator('#import-file').setInputFiles(backupFile(Array.from({length:30},(_,i)=>({id:'cloud-too-large-'+i,entity:'tasks',title:'虚构请求大小',date:'2028-03-02',note:'文'.repeat(2000)}))));await mock.waitForFunction(()=>document.getElementById('status').textContent.includes('128 KiB'));assert.equal(await mock.locator('#restore-dialog').isVisible(),false);assert.equal(await mock.evaluate(()=>window.__mockActions.includes('import')),false);
    pass('模拟云恢复超过 40 条或完整请求 128 KiB 在发送前拒绝，不自动分批');
    await mock.locator('#import-file').setInputFiles(backupFile([{id:'cloud-restore-once',entity:'tasks',title:'虚构云恢复重试测试',date:'2028-03-02'}]));await visible(mock.locator('#restore-dialog'));assert.match(await mock.locator('#restore-summary').innerText(),/40 条/);await mock.locator('#confirm-restore').click();await mock.waitForFunction(()=>document.getElementById('restore-error').textContent.includes('响应丢失'));assert.equal(await mock.locator('#restore-dialog').isVisible(),true);assert.doesNotMatch(await mock.locator('#status').innerText(),/^已恢复/);
    await mock.locator('#confirm-restore').click();await mock.locator('#restore-dialog').waitFor({state:'hidden'});const ids=await mock.evaluate(()=>window.__mockImportIds);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.match(ids[0],/^[a-f0-9-]{36}$/i);assert.equal(await recordRow(mock,'tasks','虚构云恢复重试测试').count(),1);assert.match(await mock.locator('#status').innerText(),/已确认此前恢复/);
    pass('模拟云提交后响应丢失，保留同一 requestId 重试，无重复记录且确认后才显示成功');
    await mock.evaluate(()=>window.__mockImportConflict=true);await mock.locator('#import-file').setInputFiles(backupFile([{id:'cloud-conflict',entity:'tasks',title:'虚构冲突不可新增',date:'2028-03-02'}]));await visible(mock.locator('#restore-dialog'));await mock.locator('#confirm-restore').click();await mock.waitForFunction(()=>document.getElementById('restore-error').textContent.includes('整批未新增'));assert.equal(await recordRow(mock,'tasks','虚构冲突不可新增').count(),0);await mock.locator('#cancel-restore').click();await mock.evaluate(()=>window.__mockImportConflict=false);
    pass('模拟云恢复冲突不虚报成功、不显示部分新增');
    await mock.locator('[data-create="tasks"]').click();await mock.locator('#record-form [name=title]').fill('虚构网络故障测试');await mock.locator('#record-form [name=date]').fill('2028-03-02');await mock.locator('#record-form [type=submit]').click();
    await mock.waitForFunction(()=>document.getElementById('form-error').textContent.includes('模拟网络中断'));
    assert.equal(await mock.locator('#editor').isVisible(),true);assert.equal(await mock.locator('#tasks-list .row').count(),1);assert.doesNotMatch(await mock.locator('#status').innerText(),/^已保存/);
    await mock.locator('#cancel-editor').click();await mock.locator('#logout').click();assert.equal(await mock.locator('#workspace').isVisible(),false);assert.equal(await mock.locator('#tasks-list').innerHTML(),'');assert.equal(await mock.locator('#password').inputValue(),'');assert.equal(await mock.locator('body').evaluate(n=>n.classList.contains('session-check')),false);
    assert.deepEqual(mockErrors,[]);pass('本地模拟云端网络失败不虚报成功，退出清空记录/密码/遮蔽状态（非真实云验证）');
    await mock.locator('#username').fill('fictional-test');await mock.locator('#password').fill('fictional-browser-test');await mock.locator('#login-form [type=submit]').click();await visible(mock.locator('#workspace'));
    await mock.evaluate(()=>{File.prototype.text=function(){return new Promise(resolve=>{window.__finishDelayedFile=()=>resolve(JSON.stringify({schemaVersion:1,records:[{id:'late-private-file',entity:'tasks',title:'虚构延迟读取记录',date:'2028-03-02'}]}))})};});
    await mock.locator('#import-file').setInputFiles(backupFile([{id:'unused-placeholder',entity:'tasks',title:'虚构占位',date:'2028-03-02'}]));
    await mock.waitForFunction(()=>typeof window.__finishDelayedFile==='function');
    await mock.locator('#logout').click();await mock.evaluate(()=>window.__finishDelayedFile());
    await mock.waitForTimeout(50);
    assert.equal(await mock.locator('#restore-dialog').isVisible(),false);assert.equal(await mock.locator('#restore-summary').innerText(),'');assert.equal(await mock.locator('#restore-error').innerText(),'');assert.equal(await mock.locator('#import-file').inputValue(),'');assert.equal(await mock.locator('#workspace').isVisible(),false);
    assert.deepEqual(mockErrors,[]);pass('退出期间延迟文件读取不能重新设置预览或打开恢复弹框');
    await context.close();
    console.log(`Browser checks passed: ${checks}. No real cloud login, phone hardware, cellular or sync claims.`);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
