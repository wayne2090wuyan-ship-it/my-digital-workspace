'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createService, validateRecord, ENTITIES } = require('../backend/service.cjs');

const input = (title = '虚构网络测试记录') => ({title, date:'2026-10-22'});
function fixture() {
  const rows = new Map();
  const auth = new Map([['test-a',{enabled:true}], ['test-b',{enabled:true}]]);
  const key = (uid, entity, id) => JSON.stringify([uid,entity,id]);
  const conflict = () => { throw Object.assign(new Error('Internal details must not leak'), {code:'CONFLICT'}); };
  const repo = {
    async getAuthorization(uid) { return auth.get(uid); },
    async list(uid,entity) { return [...rows.entries()].filter(([k]) => { const p=JSON.parse(k);return p[0]===uid && p[1]===entity; }).map(([,v])=>structuredClone(v)); },
    async create(uid,entity,row) { const k=key(uid,entity,row.id),old=rows.get(k);if(old) {const same=Object.keys(input()).every(f=>old[f]===row[f]);if(same)return structuredClone(old);conflict();}rows.set(k,structuredClone(row));return structuredClone(row); },
    async update(uid,entity,id,version,patch) {const k=key(uid,entity,id),row=rows.get(k);if(!row||row.version!==version)conflict();rows.set(k,{...row,...patch});return structuredClone(rows.get(k));},
    async remove(uid,entity,id,version) {const k=key(uid,entity,id),row=rows.get(k);if(!row||row.version!==version)conflict();rows.delete(k);return true;},
    async export(uid) { return [...rows.entries()].filter(([k])=>JSON.parse(k)[0]===uid).map(([,v])=>({...v,owner_id:uid,_id:'private'})); }
  };
  const as = (uid, anonymous = false) => createService({repo,getIdentity:()=>uid?{uid,anonymous}:null,clock:()=>new Date('2026-10-22T00:00:00Z')});
  return {rows,auth,repo,as};
}
test('anonymous, missing identity and unauthorized accounts are denied',async()=>{
  const {as}=fixture();
  for (const handler of [as(null),as('test-a',true),as('outsider')]) {
    const r=await handler({action:'list',payload:{entity:'tasks'}});assert.equal(r.ok,false);
  }
});
test('six modules support CRUD, export and owner isolation',async()=>{
  const {as}=fixture(),a=as('test-a'),b=as('test-b');
  for(const entity of ENTITIES){
    const created=await a({action:'create',payload:{entity,id:'id-'+entity,record:input()}});assert(created.ok);
    assert.equal((await b({action:'list',payload:{entity}})).data.length,0);
    assert.equal((await b({action:'update',payload:{entity,id:'id-'+entity,version:1,record:input('伪造')}})).ok,false);
    const updated=await a({action:'update',payload:{entity,id:'id-'+entity,version:1,record:input('虚构新标题')}});assert.equal(updated.data.version,2);
  }
  const backup=(await a({action:'export',payload:{}})).data;assert.equal(backup.records.length,6);
  assert(!JSON.stringify(backup).includes('owner_id'));assert(!JSON.stringify(backup).includes('_id'));
  for(const entity of ENTITIES)assert((await a({action:'remove',payload:{entity,id:'id-'+entity,version:2}})).ok);
});
test('payload cannot forge user identity, ownership or admin action',async()=>{
  const {as}=fixture(),a=as('test-a');
  for(const event of [
    {action:'list',uid:'test-b',payload:{entity:'tasks'}},
    {action:'list',payload:{entity:'tasks',owner_id:'test-b'}},
    {action:'create',payload:{entity:'tasks',record:{...input(),owner_id:'test-b'}}},
    {action:'create',payload:{entity:'allowed_users',record:input()}},
    {action:'import',payload:{records:[]}}
  ])assert.equal((await a(event)).ok,false);
});
test('CAS rejects stale updates and deletes; duplicate retries do not create two rows',async()=>{
  const {as}=fixture(),a=as('test-a'),payload={entity:'tasks',id:'retry-id',record:input()};
  assert((await a({action:'create',payload})).ok);assert((await a({action:'create',payload})).ok);
  assert.equal((await a({action:'list',payload:{entity:'tasks'}})).data.length,1);
  const r=await Promise.all([a({action:'update',payload:{...payload,version:1}}),a({action:'update',payload:{...payload,version:1}})]);
  assert.equal(r.filter(x=>x.ok).length,1);
  assert.equal((await a({action:'remove',payload:{entity:'tasks',id:'retry-id',version:1}})).ok,false);
});
test('revocation applies to subsequent requests despite an existing identity',async()=>{
  const {as,auth}=fixture(),a=as('test-a');assert((await a({action:'list',payload:{entity:'tasks'}})).ok);
  auth.set('test-a',{enabled:false});assert.equal((await a({action:'export',payload:{}})).error.code,'FORBIDDEN');
});
test('input limits, real dates and hidden errors',async()=>{
  for(const patch of [{title:''},{title:'x'.repeat(201)},{date:'2026-02-30'},{date:'0000-01-01'},{time:'25:00'},{stage:5},{duration:1441},{done:'true'},{note:'x'.repeat(2001)},{password:'secret'}])assert.throws(()=>validateRecord({...input(),...patch}));
  assert.equal(validateRecord({...input(),date:'2028-02-29'}).date,'2028-02-29');
  const {repo,as}=fixture();repo.list=async()=>{throw new Error('fake-database-secret')};
  const result=await as('test-a')({action:'list',payload:{entity:'tasks'}});assert.equal(result.error.code,'UNAVAILABLE');assert(!JSON.stringify(result).includes('fake-database-secret'));
});
