'use strict';

// This mock tests our transaction usage and failure handling, not CloudBase's
// production isolation/commit semantics. Those require separate deployed tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createService, MAX_EXPORT_BYTES, MAX_IMPORT_BYTES, MAX_IMPORT_RECORDS } = require('../service.cjs');
const { createCloudbaseRepository, recordKey, authorizationKey, importReceiptKey } = require('../cloudbase-repository.cjs');
const clone = value => structuredClone(value);
const UID = 'fictional-restore-a';
const RID = '12345678-1234-4234-8234-123456789abc';
const NOW = '2026-10-23T01:02:03.000Z';
const row = (id = 'new-record', entity = 'tasks') => ({ id, entity, title: '虚构恢复测试', date: '2026-10-23', version: 900, createdAt: '1900-01-01', updatedAt: '1900-01-02' });
const backup = (records = [row()]) => ({ schemaVersion: 1, exportedAt: '2026-10-22', records });
const event = (records = [row()], requestId = RID) => ({ action: 'import', payload: { requestId, backup: backup(records) } });

function database() {
  let state = new Map(), queue = Promise.resolve();
  const control = { beforeTransaction: null, failCreate: 0, ambiguousCommit: false, creates: 0, calls: 0, maxOperations: 0, transactions: 0 };
  function table(source, name) {
    if (!source.has(name)) source.set(name, new Map());
    return source.get(name);
  }
  function collection(source, name, transactional = false, operations = null) {
    return { where(condition) { return { limit() { return { async get() {
      return {data:[...table(source,name).values()].filter(row=>Object.entries(condition).every(([key,value])=>row[key]===value)).slice(0,1).map(clone)};
    } }; } }; }, doc(id) { return {
      async get() {
        if (operations) operations.count++;
        const data = table(source, name).get(id);
        // Real SDK 3.10.3: transaction get.data is an object/null; ordinary get.data is an array.
        return { data: transactional ? (data ? clone(data) : null) : (data ? [clone(data)] : []) };
      },
      async create(data) {
        assert.equal(transactional, true, 'restore must not write outside its transaction');
        operations.count++; control.creates++;
        if (control.failCreate === control.creates) throw Object.assign(new Error('fictional-secret-must-not-leak'), { code: 'SIMULATED_WRITE_FAILURE' });
        if (table(source, name).has(id)) throw Object.assign(new Error('duplicate'), { code: 'DATABASE_DUPLICATE_KEY' });
        table(source, name).set(id, { ...clone(data), _id: id });
        return { inserted: 1, ok: 1, id };
      }
    }; } };
  }
  const db = {
    collection: name => collection(state, name),
    async runTransaction(callback) {
      control.transactions++;
      // Serialize this mock's transactions to exercise same-request retries. The
      // deployed database must additionally prove its real conflict handling.
      const previous = queue; let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        if (control.beforeTransaction) await control.beforeTransaction();
        const staged = clone(state), operations = { count: 0 };
        const result = await callback({ collection: name => collection(staged, name, true, operations) });
        control.maxOperations = Math.max(control.maxOperations, operations.count);
        state = staged;
        if (control.ambiguousCommit) { control.ambiguousCommit = false; throw new Error('Commit response lost'); }
        return result;
      } finally { release(); }
    },
    seed(name, id, data) { table(state, name).set(id, { ...clone(data), _id: id }); },
    all(name) { return [...table(state, name).values()].map(clone); },
    control
  };
  return db;
}
function fixture() {
  const db = database();
  db.seed('mdw_authz', authorizationKey(UID), { uid: UID, enabled: true });
  const repo = createCloudbaseRepository(db);
  let time = NOW;
  const as = (uid = UID, anonymous = false) => createService({ repo, getIdentity: () => ({ uid, anonymous }), clock: () => new Date(time) });
  return { db, repo, handle: as(), as, setTime(value) { time = value; } };
}

test('cloud restore creates all six modules, regenerates metadata and writes a private receipt', async () => {
  const { db, handle } = fixture();
  const records = ['tasks', 'events', 'papers', 'academic', 'fitness', 'life'].map(entity => row('item-' + entity, entity));
  const result = await handle(event(records));
  assert.deepEqual(result, { ok: true, data: { count: 6, requestId: RID, replayed: false } });
  assert.equal(db.all('mdw_records').length, 6);
  for (const stored of db.all('mdw_records')) {
    assert.equal(stored.version, 1); assert.equal(stored.createdAt, NOW); assert.equal(stored.updatedAt, NOW);
    assert.equal(stored.owner_id, UID); assert.equal(stored._id, recordKey(UID, stored.entity, stored.id));
  }
  assert.equal(db.all('mdw_imports')[0]._id, importReceiptKey(UID, RID));
  assert(!JSON.stringify(result).includes(UID));
  assert(!JSON.stringify(result).includes('digest'));
});

test('same request retry is exactly-once even when timestamp/order changes', async () => {
  const { db, handle, setTime } = fixture(), records = [row('a'), row('b')];
  assert.equal((await handle(event(records))).ok, true);
  setTime('2026-10-24T01:02:03.000Z');
  const result = await handle(event([...records].reverse()));
  assert.equal(result.data.replayed, true); assert.equal(result.data.count, 2);
  assert.equal(db.all('mdw_records').length, 2); assert.equal(db.all('mdw_imports').length, 1);
  assert.equal(db.all('mdw_records')[0].createdAt, NOW);
});

test('same receipt with changed business content is rejected, never overwrites', async () => {
  const { db, handle } = fixture(); await handle(event());
  const result = await handle(event([{ ...row(), title: '不同的虚构内容' }]));
  assert.equal(result.error.code, 'CONFLICT'); assert.equal(db.all('mdw_records')[0].title, row().title);
});

test('existing id among otherwise new records causes no partial restore or receipt', async () => {
  const { db, handle } = fixture();
  db.seed('mdw_records', recordKey(UID, 'tasks', 'existing'), { ...row('existing'), owner_id: UID });
  const result = await handle(event([row('new-one'), row('existing'), row('new-two')]));
  assert.equal(result.error.code, 'CONFLICT'); assert.equal(db.all('mdw_records').length, 1); assert.equal(db.all('mdw_imports').length, 0);
});

test('failure during record or receipt write rolls back all writes without raw errors', async () => {
  for (const failure of [2, 3]) {
    const { db, handle } = fixture(); db.control.failCreate = failure;
    const result = await handle(event([row('a'), row('b')]));
    assert.equal(result.error.code, 'UNAVAILABLE'); assert(!JSON.stringify(result).includes('fictional-secret'));
    assert.equal(db.all('mdw_records').length, 0); assert.equal(db.all('mdw_imports').length, 0);
  }
});

test('uncertain successful commit is recovered by same request UUID without duplicate writes', async () => {
  const { db, handle } = fixture(); db.control.ambiguousCommit = true;
  assert.equal((await handle(event())).error.code, 'UNAVAILABLE'); assert.equal(db.all('mdw_records').length, 1);
  assert.equal((await handle(event())).data.replayed, true); assert.equal(db.all('mdw_records').length, 1);
});

test('simultaneous identical requests share one receipt and one set of rows', async () => {
  const { db, handle } = fixture(); const results = await Promise.all([handle(event()), handle(event())]);
  assert(results.every(result => result.ok)); assert.equal(results.filter(result => result.data.replayed).length, 1);
  assert.equal(db.all('mdw_records').length, 1); assert.equal(db.all('mdw_imports').length, 1);
});

test('authorization is read again inside transaction and revocation prevents writes', async () => {
  const { db, handle } = fixture();
  db.control.beforeTransaction = () => db.seed('mdw_authz', authorizationKey(UID), { uid: UID, enabled: false });
  const result = await handle(event()); assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal(db.all('mdw_records').length, 0); assert.equal(db.all('mdw_imports').length, 0);
});

test('missing/anonymous/unauthorized identity cannot reach a restore transaction', async () => {
  const { db, as } = fixture();
  for (const handler of [as('', false), as(UID, true), as('fictional-outsider')]) assert.equal((await handler(event())).ok, false);
  assert.equal(db.control.transactions, 0); assert.equal(db.all('mdw_records').length, 0);
});

test('owners have isolated records and receipts even for identical request and record IDs', async () => {
  const { db, handle, as } = fixture(), other = 'fictional-restore-b';
  db.seed('mdw_authz', authorizationKey(other), { uid: other, enabled: true });
  assert.equal((await handle(event())).ok, true); assert.equal((await as(other)(event())).ok, true);
  assert.equal(db.all('mdw_records').length, 2); assert.equal(db.all('mdw_imports').length, 2);
});

test('external ownership, credentials and nested unknown fields are all rejected before transaction', async () => {
  const { db, handle } = fixture();
  const bad = [
    { ...event(), uid: 'forged' },
    { action: 'import', payload: { ...event().payload, uid: 'forged' } },
    { action: 'import', payload: { ...event().payload, backup: { ...backup(), uid: 'forged' } } },
    ...['uid', 'user_id', 'owner_id', '_id', '_openid', 'password', 'token', 'secretKey', 'constructor', '__proto__'].map(key => event([JSON.parse(JSON.stringify(row()).slice(0, -1) + ',"' + key + '":"forged"}')])),
    event([row('duplicate'), row('duplicate')]), event([{ ...row(), entity: 'mdw_authz' }]), event([{ ...row(), date: '2026-02-30' }]),
    event([], RID), event([row()], 'not-a-uuid')
  ];
  for (const input of bad) assert.equal((await handle(input)).ok, false, JSON.stringify(input));
  assert.equal(db.control.transactions, 0); assert.equal(db.all('mdw_records').length, 0);
});

test('40 rows use at most 83 operations; 41 rows and >128KiB fail without auto-batching', async () => {
  const { db, handle } = fixture();
  assert.equal(MAX_IMPORT_RECORDS, 40); assert.equal(MAX_IMPORT_BYTES, 128 * 1024);
  assert.equal((await handle(event(Array.from({ length: 40 }, (_, i) => row('item-' + i))))).ok, true);
  assert.equal(db.control.maxOperations, 83); assert.equal(db.control.transactions, 1);
  assert.equal((await handle(event(Array.from({ length: 41 }, (_, i) => row('other-' + i))))).error.code, 'LIMIT');
  // Each field is individually valid, but the UTF-8 request exceeds 128 KiB.
  assert.equal((await handle(event(Array.from({ length: 30 }, (_, i) => ({ ...row('large-' + i), note: '虚'.repeat(2000) }))))).error.code, 'LIMIT');
  assert.equal(db.control.transactions, 1); assert.equal(db.all('mdw_records').length, 40);
});

test('provider lacking actual transaction support cannot fall back to partial writes', async () => {
  const db = database(); db.seed('mdw_authz', authorizationKey(UID), { uid: UID, enabled: true }); delete db.runTransaction;
  const handle = createService({ repo: createCloudbaseRepository(db), getIdentity: () => ({ uid: UID, anonymous: false }) });
  assert.equal((await handle(event())).error.code, 'UNAVAILABLE'); assert.equal(db.all('mdw_records').length, 0);
});

test('cloud export rejects more than 4 MiB without returning a partial backup', async () => {
  const repo = { getAuthorization: async () => ({ enabled: true }), export: async () => [{ ...row(), note: '虚'.repeat(Math.floor(MAX_EXPORT_BYTES / 3)) }] };
  const handle = createService({ repo, getIdentity: () => ({ uid: UID, anonymous: false }) });
  const result = await handle({ action: 'export', payload: {} });
  assert.equal(MAX_EXPORT_BYTES, 4 * 1024 * 1024); assert.equal(result.error.code, 'LIMIT'); assert.equal(result.data, undefined);
});
