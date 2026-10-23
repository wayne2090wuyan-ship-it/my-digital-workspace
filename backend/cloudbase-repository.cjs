'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const ENTITIES = new Set(['tasks', 'events', 'papers', 'academic', 'fitness', 'life', 'settings']);
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const recordKey = (uid, entity, id) => hash(JSON.stringify([uid, entity, id]));
const authorizationKey = uid => hash(JSON.stringify(['authorization', uid]));
const importReceiptKey = (uid, requestId) => hash(JSON.stringify(['import', uid, requestId]));
const IMPORT_FIELDS = Object.freeze(['id', 'entity', 'title', 'date', 'time', 'note', 'done', 'stage', 'goal', 'deadline', 'location', 'duration']);

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function assertIdentity(uid, entity, id) {
  if (typeof uid !== 'string' || !uid || uid.length > 512) throw problem('UNAUTHORIZED', '登录状态无效');
  if (entity !== undefined && !ENTITIES.has(entity)) throw problem('INVALID_INPUT', '未知数据模块');
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > 80)) throw problem('INVALID_INPUT', '记录编号无效');
}
function ensureResult(result) {
  if (!result || (result.code && result.code !== 0)) throw problem('BACKEND_ERROR', '云数据库请求失败');
  return result;
}
function rows(result) {
  const data = ensureResult(result).data;
  if (data === undefined || data === null) return [];
  return Array.isArray(data) ? data : [data];
}
async function documentRows(request) {
  try { return rows(await request); }
  catch (error) {
    // The real gateway returns DOCUMENT_NOT_FOUND for absent exact-ID reads,
    // including optimized where({_id}) queries. Other errors must fail closed.
    if (error?.code === 'DOCUMENT_NOT_FOUND') return [];
    throw error;
  }
}
function publicRecord(row) {
  const { _id, _openid, owner_id, ...record } = row;
  return clone(record);
}
function mutable(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw problem('INVALID_INPUT', '记录无效');
  const forbidden = ['_id', '_openid', 'owner_id', '__proto__', 'constructor', 'prototype'];
  if (forbidden.some(key => Object.hasOwn(record, key))) throw problem('INVALID_INPUT', '不可设置内部字段');
  return clone(record);
}
function businessContent(record) {
  const { createdAt, updatedAt, created_at, updated_at, version, ...content } = record;
  return content;
}

function createCloudbaseRepository(db, options = {}) {
  if (!db || typeof db.collection !== 'function') throw problem('CONFIGURATION_ERROR', '数据库模式配置不完整');
  const recordsName = options.recordsCollection || 'mdw_records';
  const authzName = options.authorizationCollection || 'mdw_authz';
  const importsName = options.importsCollection || 'mdw_imports';
  const maxExport = options.maxExport || 10000;
  const maxImport = options.maxImport ?? 40;
  if (!Number.isInteger(maxImport) || maxImport < 1 || maxImport > 40) throw problem('CONFIGURATION_ERROR', '事务恢复上限必须为 1 至 40 条');
  const records = () => db.collection(recordsName);

  async function get(uid, entity, id) {
    assertIdentity(uid, entity, id);
    const found = await documentRows(records().where({ _id: recordKey(uid, entity, id) }).limit(1).get());
    if (!found.length) return null;
    const row = found[0];
    // Hashes are identifiers, not authorization. Verify ownership again.
    if (row.owner_id !== uid || row.entity !== entity || row.id !== id) throw problem('FORBIDDEN', '记录归属不匹配');
    return publicRecord(row);
  }

  return Object.freeze({
    async getAuthorization(uid) {
      assertIdentity(uid);
      const found = await documentRows(db.collection(authzName).where({ _id: authorizationKey(uid) }).limit(1).get());
      if (!found.length || found[0].uid !== uid || found[0].enabled !== true) return null;
      return { enabled: true, ...(found[0].revokedBefore ? { revokedBefore: found[0].revokedBefore } : {}) };
    },
    get,
    async list(uid, entity, options = {}) {
      assertIdentity(uid, entity);
      const limit = options.limit ?? 1000;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw problem('INVALID_INPUT', '查询数量超出范围');
      // SDK/server per-request limits vary; page in batches of 100 without silently truncating.
      const out = [];
      let cursor = options.cursor || null;
      if (cursor && (typeof cursor !== 'string' || cursor.length > 80)) throw problem('INVALID_INPUT', '查询游标无效');
      while (out.length <= limit) {
        const condition = { owner_id: uid, entity };
        if (cursor) condition.id = db.command.gt(cursor);
        const page = rows(await records().where(condition).orderBy('id', 'asc').limit(Math.min(100, limit + 1 - out.length)).get());
        for (const row of page) {
          if (row.owner_id !== uid || row.entity !== entity || typeof row.id !== 'string') throw problem('FORBIDDEN', '查询返回了非法归属');
          out.push(publicRecord(row));
        }
        if (!page.length || out.length > limit) break;
        const next = page.at(-1).id;
        if (next === cursor) throw problem('BACKEND_ERROR', '查询游标未前进');
        cursor = next;
      }
      if (out.length > limit) throw problem('LIMIT', '记录过多，请缩小查询范围或分批导出');
      return out;
    },
    async create(uid, entity, record) {
      assertIdentity(uid, entity, record?.id);
      const clean = mutable(record);
      if (clean.entity !== entity || clean.version !== 1) throw problem('INVALID_INPUT', '新记录版本或模块无效');
      const document = { ...clean, owner_id: uid, _id: recordKey(uid, entity, clean.id) };
      try {
        ensureResult(await records().add(document));
        return publicRecord(document);
      } catch (error) {
        // On duplicate or uncertain outcome, read back. Never use upsert/set for creation.
        const existing = await get(uid, entity, clean.id);
        if (existing && existing.version === 1 && isDeepStrictEqual(businessContent(existing), businessContent(clean))) return existing;
        if (existing) throw problem('CONFLICT', '相同编号已存在不同记录');
        throw error;
      }
    },
    async update(uid, entity, id, version, patch) {
      assertIdentity(uid, entity, id);
      if (!Number.isSafeInteger(version) || version < 1) throw problem('INVALID_INPUT', '版本号无效');
      const clean = mutable(patch);
      if ((clean.id !== undefined && clean.id !== id) || (clean.entity !== undefined && clean.entity !== entity)) throw problem('INVALID_INPUT', '不可更改记录编号或模块');
      const existing = await get(uid, entity, id);
      if (!existing) throw problem('NOT_FOUND', '记录不存在或无权访问');
      if (existing.version !== version) throw problem('CONFLICT', '记录已被修改，请刷新后重试');
      const next = { ...existing, ...clean, id, entity, version: version + 1, createdAt: existing.createdAt };
      const condition = { _id: recordKey(uid, entity, id), owner_id: uid, entity, id, version };
      // Single-document conditional update: the version comparison and write are one operation.
      const result = ensureResult(await records().where(condition).update(next));
      if (result.updated !== 1) throw problem('CONFLICT', '记录已变化，未覆盖其他设备的修改');
      return next;
    },
    async remove(uid, entity, id, version) {
      assertIdentity(uid, entity, id);
      if (!Number.isSafeInteger(version) || version < 1) throw problem('INVALID_INPUT', '版本号无效');
      const result = ensureResult(await records().where({ _id: recordKey(uid, entity, id), owner_id: uid, entity, id, version }).remove());
      if (result.deleted !== 1) throw problem('CONFLICT', '记录已变化或不存在，请刷新');
      return true;
    },
    async import(uid, requestId, input) {
      assertIdentity(uid);
      if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) throw problem('INVALID_INPUT', '恢复请求编号无效');
      if (!Array.isArray(input) || !input.length || input.length > maxImport || Buffer.byteLength(JSON.stringify(input), 'utf8') > 128 * 1024) throw problem('LIMIT', '事务恢复超出限制，未写入任何记录');
      if (typeof db.runTransaction !== 'function') throw problem('CONFIGURATION_ERROR', '当前数据库不支持原子恢复');
      const seen = new Set();
      const clean = input.map(row => {
        assertIdentity(uid, row?.entity, row?.id);
        const result = mutable(row), key = recordKey(uid, row.entity, row.id);
        if (row.entity === 'settings' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || result.version !== 1 || typeof result.createdAt !== 'string' || result.createdAt !== result.updatedAt || !Number.isFinite(Date.parse(result.createdAt))) throw problem('INVALID_INPUT', '恢复记录格式无效');
        if (Object.keys(result).some(key => ![...IMPORT_FIELDS, 'version', 'createdAt', 'updatedAt'].includes(key))) throw problem('INVALID_INPUT', '恢复包含禁止字段');
        if (seen.has(key)) throw problem('INVALID_INPUT', '恢复含重复编号');
        seen.add(key);
        return result;
      });
      // Stable, ownership-free digest: retries may regenerate server timestamps,
      // but neither changed content nor a reused request UUID may be accepted.
      const canonical = clean.map(row => Object.fromEntries(IMPORT_FIELDS.map(key => [key, row[key]])))
        .sort((a, b) => a.entity === b.entity ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.entity < b.entity ? -1 : 1));
      const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      const receiptId = importReceiptKey(uid, requestId);
      return db.runTransaction(async transaction => {
        // This second authorization read belongs to the SAME transaction as all
        // writes. Browser input and an earlier successful check are insufficient.
        const auth = (await documentRows(transaction.collection(authzName).doc(authorizationKey(uid)).get()))[0];
        if (!auth || auth.uid !== uid || auth.enabled !== true) throw problem('FORBIDDEN', '恢复账号未获授权');
        const receiptDoc = transaction.collection(importsName).doc(receiptId);
        const receipt = (await documentRows(receiptDoc.get()))[0];
        if (receipt) {
          if (receipt.owner_id !== uid || receipt.requestId !== requestId || receipt.digest !== digest || receipt.count !== clean.length) throw problem('CONFLICT', '恢复请求编号已用于其他内容');
          return { count: receipt.count, requestId, replayed: true };
        }
        // At most 83 transactional operations: auth + receipt + 40 existence
        // reads + 40 non-upsert creates + receipt create; below CloudBase's 100.
        for (const row of clean) {
          const existing = await documentRows(transaction.collection(recordsName).doc(recordKey(uid, row.entity, row.id)).get());
          if (existing.length) throw problem('CONFLICT', '恢复编号已存在；不覆盖任何记录');
        }
        for (const row of clean) {
          const id = recordKey(uid, row.entity, row.id);
          const result = ensureResult(await transaction.collection(recordsName).doc(id).create({ ...row, owner_id: uid }));
          if (result.inserted !== 1 || result.ok !== 1 || result.id !== id) throw problem('BACKEND_ERROR', '数据库未确认恢复写入');
        }
        const result = ensureResult(await receiptDoc.create({ owner_id: uid, requestId, digest, count: clean.length, createdAt: clean[0].createdAt }));
        if (result.inserted !== 1 || result.ok !== 1 || result.id !== receiptId) throw problem('BACKEND_ERROR', '数据库未确认恢复回执');
        return { count: clean.length, requestId, replayed: false };
      });
    },
    async export(uid) {
      assertIdentity(uid);
      const out = [];
      let cursor = null;
      while (true) {
        const condition = { owner_id: uid };
        if (cursor) condition._id = db.command.gt(cursor);
        const page = rows(await records().where(condition).orderBy('_id', 'asc').limit(100).get());
        if (!page.length) return out;
        for (const row of page) {
          if (row.owner_id !== uid || !ENTITIES.has(row.entity)) throw problem('FORBIDDEN', '导出包含非法归属');
          out.push(publicRecord(row));
        }
        if (out.length > maxExport) throw problem('LIMIT', '导出数量超限，未生成不完整备份');
        const next = page.at(-1)._id;
        if (!next || next === cursor) throw problem('BACKEND_ERROR', '导出游标未前进');
        cursor = next;
      }
    }
  });
}

module.exports = { createCloudbaseRepository, recordKey, authorizationKey, importReceiptKey };
