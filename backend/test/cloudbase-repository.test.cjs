'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudbaseRepository, recordKey, authorizationKey } = require('../cloudbase-repository.cjs');
const { createEntrypoint } = require('../index.cjs');

const copy = x => JSON.parse(JSON.stringify(x));
function mockDatabase() {
  const collections = new Map();
  function bucket(name) { if (!collections.has(name)) collections.set(name, new Map()); return collections.get(name); }
  function query(name, condition = {}, count = 100, order = null) {
    const match = row => Object.entries(condition).every(([key, value]) => value && value.op === 'gt' ? row[key] > value.value : row[key] === value);
    return {
      where(next) { return query(name, next, count, order); },
      orderBy(field) { return query(name, condition, count, field); },
      limit(next) { return query(name, condition, next, order); },
      async get() {
        let data = [...bucket(name).values()].filter(match);
        if (order) data.sort((a,b) => a[order] < b[order] ? -1 : a[order] > b[order] ? 1 : 0);
        return { data: copy(data.slice(0, Math.min(count, 100))) };
      },
      async update(patch) {
        let updated = 0;
        for (const [id, row] of bucket(name)) if (match(row)) { bucket(name).set(id, { ...row, ...copy(patch) }); updated++; }
        return { updated };
      },
      async remove() { let deleted = 0; for (const [id,row] of bucket(name)) if (match(row)) { bucket(name).delete(id); deleted++; } return { deleted }; },
      doc(id) { return { async get() { return { data: bucket(name).has(id) ? [copy(bucket(name).get(id))] : [] }; } }; },
      async add(row) { if (bucket(name).has(row._id)) throw Object.assign(new Error('duplicate'), { code:'DUPLICATE' }); bucket(name).set(row._id, copy(row)); return { id:row._id }; }
    };
  }
  return { collection:name => query(name), command:{ gt:value => ({op:'gt',value}) }, seed(name,id,row){bucket(name).set(id,{...copy(row),_id:id});} };
}
const sample = (id='r1') => ({ id, entity:'tasks', title:'虚构测试', done:false, date:'2026-10-22', version:1, createdAt:'2026-10-22T00:00:00.000Z', updatedAt:'2026-10-22T00:00:00.000Z' });

test('gateway missing exact-ID response means absent, other failures stay errors', async () => {
  let code='DOCUMENT_NOT_FOUND';const db={collection:()=>({where:()=>({limit:()=>({get:async()=>{throw Object.assign(new Error('gateway'),{code});}})})})};
  const repo=createCloudbaseRepository(db);
  assert.equal(await repo.getAuthorization('unapproved'),null);
  assert.equal(await repo.get('A','tasks','missing'),null);
  code='DATABASE_PERMISSION_DENIED';await assert.rejects(repo.getAuthorization('A'),{code});
});

test('ownership, private fields and strict server authorization', async () => {
  const db=mockDatabase(), repo=createCloudbaseRepository(db);
  await repo.create('A','tasks',sample());
  assert.equal(await repo.get('B','tasks','r1'),null);
  assert.deepEqual(await repo.list('B','tasks'),[]);
  const result=await repo.get('A','tasks','r1');
  assert.equal(result.entity,'tasks');assert(!('_id' in result));assert(!('owner_id' in result));
  assert.equal(await repo.getAuthorization('A'),null);
  db.seed('mdw_authz',authorizationKey('A'),{uid:'A',enabled:'true'});
  assert.equal(await repo.getAuthorization('A'),null);
  db.seed('mdw_authz',authorizationKey('A'),{uid:'A',enabled:true});
  assert.deepEqual(await repo.getAuthorization('A'),{enabled:true});
  await assert.rejects(repo.create('A','tasks',{...sample('bad'),owner_id:'B'}),{code:'INVALID_INPUT'});
});

test('create is idempotent but never overwrites another payload', async () => {
  const repo=createCloudbaseRepository(mockDatabase());
  const one=await repo.create('A','tasks',sample());
  assert.deepEqual(await repo.create('A','tasks',{...sample(),updatedAt:'2026-10-23T00:00:00.000Z'}),one);
  await assert.rejects(repo.create('A','tasks',{...sample(),title:'不同的虚构内容'}),{code:'CONFLICT'});
  assert.equal((await repo.get('A','tasks','r1')).title,'虚构测试');
});

test('parallel compare-and-swap only lets one update win', async () => {
  const repo=createCloudbaseRepository(mockDatabase());await repo.create('A','tasks',sample());
  const results=await Promise.allSettled([
    repo.update('A','tasks','r1',1,{title:'虚构修改甲'}),
    repo.update('A','tasks','r1',1,{title:'虚构修改乙'})
  ]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.code,'CONFLICT');
  assert.equal((await repo.get('A','tasks','r1')).version,2);
  await assert.rejects(repo.remove('A','tasks','r1',1),{code:'CONFLICT'});
  await assert.rejects(repo.remove('B','tasks','r1',2),{code:'CONFLICT'});
  assert.equal(await repo.remove('A','tasks','r1',2),true);
  assert.equal(await repo.get('A','tasks','r1'),null);
});

test('export traverses more than a server page; list/export limits fail rather than truncate', async () => {
  const db=mockDatabase(), repo=createCloudbaseRepository(db);
  for(let n=0;n<205;n++)await repo.create('A','tasks',sample(String(n).padStart(4,'0')));
  await repo.create('B','tasks',sample('other-user'));
  assert.equal((await repo.list('A','tasks')).length,205);
  assert.equal((await repo.export('A')).length,205);
  await assert.rejects(repo.list('A','tasks',{limit:200}),{code:'LIMIT'});
  const tiny=createCloudbaseRepository(db,{maxExport:200});
  await assert.rejects(tiny.export('A'),{code:'LIMIT'});
});

test('hash is scoped by caller/module and ownership is verified even after hash lookup', async () => {
  assert.notEqual(recordKey('A','tasks','x'),recordKey('B','tasks','x'));
  const db=mockDatabase(),repo=createCloudbaseRepository(db);
  db.seed('mdw_records',recordKey('A','tasks','r1'),{...sample(),owner_id:'B'});
  await assert.rejects(repo.get('A','tasks','r1'),{code:'FORBIDDEN'});
});

test('entrypoint trusts only SDK runtime identity, refuses missing/anonymous/mismatched env', async () => {
  let runtime={},calls=0,config;
  const sdk={ getCloudbaseContext(){return runtime;}, init(value){config=value;return {database:()=>mockDatabase()};} };
  const entry=createEntrypoint({sdk,environmentId:'test-env',serviceFactory:({getIdentity})=>async()=>{calls++;return {ok:true,data:getIdentity()};}});
  assert.equal((await entry({uid:'A',userInfo:{uid:'A'}},{})).error.code,'UNAUTHORIZED');
  runtime={TCB_UUID:'A',TCB_ISANONYMOUS_USER:'true'};
  assert.equal((await entry({},{})).error.code,'UNAUTHORIZED');
  runtime={TCB_UUID:'A',LOGINTYPE:'ANONYMOUS'};
  assert.equal((await entry({},{})).error.code,'UNAUTHORIZED');
  runtime={TCB_UUID:'A',LOGINTYPE:'USERNAME'};
  assert.equal((await entry({},{})).error.code,'UNAUTHORIZED');
  runtime={TCB_UUID:'A',TCB_ISANONYMOUS_USER:'unknown',LOGINTYPE:'USERNAME'};
  assert.equal((await entry({},{})).error.code,'UNAUTHORIZED');
  runtime={TCB_UUID:'A',TCB_ISANONYMOUS_USER:false,LOGINTYPE:'ANONYMOUS'};
  assert.equal((await entry({},{})).error.code,'UNAUTHORIZED');
  runtime={TCB_UUID:'A',TCB_ISANONYMOUS_USER:false,TCB_ENV:'wrong-env'};
  assert.equal((await entry({},{})).error.code,'CONFIGURATION_ERROR');
  runtime={TCB_UUID:'A',TCB_ISANONYMOUS_USER:'false',TCB_ENV:'test-env',LOGINTYPE:'USERNAME'};
  const result=await entry({uid:'B'},{});
  assert.deepEqual(result,{ok:true,data:{uid:'A',anonymous:false}});assert.equal(calls,1);assert.equal(config.env,'test-env');
});

test('SDK errors cannot leak credentials through the entrypoint', async () => {
  const sdk={getCloudbaseContext:()=>({TCB_UUID:'A',TCB_ISANONYMOUS_USER:false}),init(){throw new Error('sensitive raw SDK output');}};
  const entry=createEntrypoint({sdk,environmentId:'test-env',serviceFactory:()=>{throw new Error('unexpected');}});
  assert.deepEqual(await entry({},{}),{ok:false,error:{code:'BACKEND_ERROR',message:'服务暂时不可用，请稍后重试'}});
});

test('entrypoint discards platform userInfo without trusting it or dropping other fields', async () => {
  const sdk={getCloudbaseContext:()=>({TCB_UUID:'trusted',TCB_ISANONYMOUS_USER:false}),init:()=>({database:()=>mockDatabase()})};
  const entry=createEntrypoint({sdk,environmentId:'test-env',serviceFactory:({getIdentity})=>async request=>({identity:getIdentity(),request})});
  assert.deepEqual(await entry({action:'list',payload:{entity:'tasks'},userInfo:{uid:'forged'},tcbContext:{TCB_UUID:'forged'},owner_id:'forged'},{}),{
    identity:{uid:'trusted',anonymous:false},request:{action:'list',payload:{entity:'tasks'},owner_id:'forged'}
  });
});
