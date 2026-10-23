import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../private/demo-provider.js',import.meta.url),'utf8');
const demoURL='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const {createDemoProvider,validateRecord,validateBackup,entities,MAX_BACKUP_BYTES}=await import(demoURL);
const policySource=await readFile(new URL('../private/backup-policy.js',import.meta.url),'utf8');
const policy=await import('data:text/javascript;base64,'+Buffer.from(policySource.replace("'./demo-provider.js'",JSON.stringify(demoURL))).toString('base64'));
const input=(title='虚构测试')=>({title,date:'2026-10-22',time:'12:30',note:'虚构短备注',done:false,stage:1,goal:'示例目标',deadline:'2026-11-02',location:'虚构研讨室',duration:20});

for(const entity of entities)test(`${entity}: create/read/update/delete and immutable reads`,async()=>{
  const p=createDemoProvider(),id=`test-${entity}`;
  const row=await p.request('create',{entity,id,record:input()});
  assert.equal(row.version,1);assert.equal(row.entity,entity);
  row.title='local mutation';
  assert.equal((await p.request('list',{entity})).find(r=>r.id===id).title,'虚构测试');
  const saved=await p.request('update',{entity,id,version:1,record:input('示例修改')});
  assert.equal(saved.version,2);assert.equal(saved.title,'示例修改');
  await p.request('remove',{entity,id,version:2});
  assert.equal((await p.request('list',{entity})).filter(r=>r.id===id).length,0);
});

test('same UUID and identical payload is idempotent; changed payload conflicts',async()=>{
  const p=createDemoProvider(),request={entity:'tasks',id:'idempotent-test',record:input()};
  const first=await p.request('create',request),second=await p.request('create',request);
  assert.deepEqual(first,second);
  assert.equal((await p.request('list',{entity:'tasks'})).filter(r=>r.id===request.id).length,1);
  await assert.rejects(()=>p.request('create',{...request,record:input('different')}),e=>e.code==='CONFLICT');
  const separate=await p.request('create',{...request,entity:'life'});assert.equal(separate.entity,'life');assert.equal(separate.id,first.id);
});

test('stale versions never silently overwrite or delete',async()=>{
  const p=createDemoProvider(),entity='tasks',id='version-test';
  await p.request('create',{entity,id,record:input()});
  await p.request('update',{entity,id,version:1,record:input('first update')});
  await assert.rejects(()=>p.request('update',{entity,id,version:1,record:input('stale update')}),e=>e.code==='CONFLICT');
  await assert.rejects(()=>p.request('remove',{entity,id,version:1}),e=>e.code==='CONFLICT');
  assert.equal((await p.request('list',{entity})).find(r=>r.id===id).title,'first update');
});

test('dates, times, lengths and scalar types validated',()=>{
  for(const date of ['2026-02-30','2026-13-01','0000-01-01','2026-1-01','2026-02-29','not-a-date'])assert.throws(()=>validateRecord({...input(),date}),e=>e.code==='VALIDATION');
  assert.equal(validateRecord({...input(),date:'2028-02-29'}).date,'2028-02-29');
  assert.equal(validateRecord({...input(),date:'0001-01-01'}).date,'0001-01-01');
  for(const time of ['24:00','12:60','1:00'])assert.throws(()=>validateRecord({...input(),time}));
  for(const patch of [{title:' '},{title:'x'.repeat(201)},{note:'x'.repeat(2001)},{goal:'x'.repeat(501)},{done:'false'},{stage:5},{stage:1.2},{duration:-1},{duration:1441},{duration:1.2}])assert.throws(()=>validateRecord({...input(),...patch}));
});

test('credentials, privilege and identity fields are rejected on all write paths',async()=>{
  const p=createDemoProvider();
  for(const field of ['owner_id','_openid','userId','uid','token','access_token','refresh_token','password','secretKey','service_role','__proto__']){
    const record={...input(),[field]:'must-not-be-accepted'};
    assert.throws(()=>validateRecord(record));
    await assert.rejects(()=>p.request('create',{entity:'tasks',record}));
    assert.throws(()=>validateBackup({schemaVersion:1,records:[{id:'test',entity:'tasks',...record}]}));
  }
  assert.throws(()=>validateBackup({schemaVersion:1,records:[],token:'not-allowed'}));
});

test('backup export, validated preview, atomic restore and collision handling',async()=>{
  const p=createDemoProvider(),backup=await p.request('export');
  assert.equal(backup.records.length,6);assert.equal(backup.schemaVersion,1);
  const before=await p.request('export');
  const mixed={schemaVersion:1,records:[{id:'new-valid',entity:'tasks',...input()},backup.records[0]]};
  await assert.rejects(()=>p.request('import',{backup:mixed}),e=>e.code==='CONFLICT');
  assert.deepEqual((await p.request('export')).records,before.records,'collision changes no rows');
  const invalid={schemaVersion:1,records:[{id:'valid-first',entity:'tasks',...input()},{id:'invalid-second',entity:'life',...input(),date:'bad'}]};
  await assert.rejects(()=>p.request('import',{backup:invalid}));
  assert.deepEqual((await p.request('export')).records,before.records,'validation failure changes no rows');
  const duplicate={schemaVersion:1,records:[{id:'duplicate',entity:'tasks',...input()},{id:'duplicate',entity:'tasks',...input()}]};
  assert.throws(()=>validateBackup(duplicate));
  const crossEntity={schemaVersion:1,records:[{id:'shared-id',entity:'tasks',...input()},{id:'shared-id',entity:'life',...input()}]};
  assert.equal(validateBackup(crossEntity).records.length,2);
  assert.equal((await p.request('import',{backup:crossEntity})).count,2);
  assert.equal((await p.request('export')).records.filter(r=>r.id==='shared-id').length,2);
  const restored=await p.request('import',{backup:{schemaVersion:1,records:[{id:'restored',entity:'life',...input()}]}});
  assert.equal(restored.count,1);
  assert.equal((await p.request('list',{entity:'life'})).find(r=>r.id==='restored').version,1);
  assert.throws(()=>validateBackup({schemaVersion:2,records:[]}));
  assert.throws(()=>validateBackup({schemaVersion:1,records:Array(2001).fill({})}));
});

test('backup file/demo 8 MiB and cloud export 4 MiB use UTF-8 bytes',async()=>{
  assert.equal(MAX_BACKUP_BYTES,8*1024*1024);
  assert.equal(policy.exportByteLimit('demo'),8*1024*1024);
  assert.equal(policy.exportByteLimit('cloud'),4*1024*1024);
  assert.equal(new Blob(['文']).size,3);
  const ui=await readFile(new URL('../private/workspace.js',import.meta.url),'utf8');
  assert.match(ui,/blob\.size>limit/);
  assert.match(ui,/file\.size>MAX_BACKUP_BYTES/);
});

test('cloud restore enforces 40 records and the full 128 KiB import envelope',()=>{
  const requestId='12345678-1234-4234-8234-123456789abc';
  const rows=Array.from({length:40},(_,i)=>({id:'bounded-'+i,entity:'tasks',...input()}));
  const backup={schemaVersion:1,records:rows};
  const first=policy.buildRestoreRequest('cloud',backup,requestId);
  const retry=policy.buildRestoreRequest('cloud',backup,requestId);
  assert.deepEqual(first,retry);assert.equal(first.requestId,requestId);
  assert.equal(policy.MAX_CLOUD_RESTORE_RECORDS,40);assert.equal(policy.MAX_CLOUD_RESTORE_BYTES,128*1024);
  assert.throws(()=>policy.buildRestoreRequest('cloud',{schemaVersion:1,records:[...rows,{...rows[0],id:'one-too-many'}]},requestId),e=>e.code==='LIMIT');
  const large={schemaVersion:1,records:rows.slice(0,30).map(r=>({...r,note:'文'.repeat(2000)}))};
  assert.throws(()=>policy.buildRestoreRequest('cloud',large,requestId),e=>e.code==='LIMIT'&&/128 KiB/.test(e.message));
  assert.throws(()=>policy.buildRestoreRequest('cloud',{schemaVersion:1,records:[]},requestId),e=>e.code==='VALIDATION');
  assert.throws(()=>policy.buildRestoreRequest('cloud',backup,'not-a-uuid'),e=>e.code==='VALIDATION');
  assert.equal(policy.buildRestoreRequest('demo',large).backup.records.length,30,'demo restore does not claim cloud transaction limits');
});

test('reset and a new demo session restore seeds and never authenticate users',async()=>{
  const p=createDemoProvider();await p.request('create',{entity:'tasks',record:input()});
  await p.request('reset');assert.equal((await p.request('export')).records.length,6);
  await assert.rejects(()=>p.signIn({username:'not-real',password:'not-real'}),e=>e.code==='DEMO');
  await p.signOut();assert.equal((await p.request('export')).records.length,0);
  assert.equal((await createDemoProvider().request('export')).records.length,6);
});

test('demo provider has no network/storage dependency, including execution under throwing globals',async()=>{
  assert.doesNotMatch(source,/\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|sendBeacon)\b/);
  const wrapped=source.replace(/export /g,'')+'\n globalThis.make = createDemoProvider;';
  const blocked=()=>{throw new Error('unexpected network or storage access')};
  const ctx=vm.createContext({structuredClone,Intl,Date,crypto:globalThis.crypto,fetch:blocked,XMLHttpRequest:blocked,WebSocket:blocked});
  for(const key of ['localStorage','sessionStorage','indexedDB'])Object.defineProperty(ctx,key,{get:blocked});
  vm.runInContext(wrapped,ctx);const p=ctx.make();
  await p.request('create',{entity:'tasks',record:input()});await p.request('export');await p.request('reset');
});

test('private UI fails closed and clears stale session mask and records before login',async()=>{
  const ui=await readFile(new URL('../private/workspace.js',import.meta.url),'utf8');
  assert.match(ui,/function clearPrivate\(\)\{generation\+\+;(?:importAttempt\+\+;)?records=\[\];document\.body\.classList\.remove\('session-check'\)/);
  assert.match(ui,/async function enter\(\)\{clearPrivate\(\)/);
  assert.match(ui,/mode!=='cloud'/);
  assert.match(ui,/pendingRequestId=payload\.requestId/);
  assert.match(ui,/buildRestoreRequest\(provider\.mode,pendingBackup,pendingRequestId\)/);
  assert.doesNotMatch(ui,/\.innerHTML\s*=/);
});
