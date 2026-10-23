'use strict';

// Provider-independent authorization and validation. Cloud identity is injected only
// by the trusted function adapter; no user ID from event/payload is accepted.
const { randomUUID } = require('node:crypto');
const ENTITIES = Object.freeze(['tasks', 'events', 'papers', 'academic', 'fitness', 'life']);
const FIELDS = Object.freeze(['title', 'date', 'time', 'note', 'done', 'stage', 'goal', 'deadline', 'location', 'duration']);
const MAX_IMPORT_RECORDS = 40;
const MAX_IMPORT_BYTES = 128 * 1024;
const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
class ServiceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new ServiceError(code, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value, keys) {
  if (!object(value) || Object.keys(value).some(k => !keys.includes(k))) fail('VALIDATION', '请求包含不允许的字段。');
}
function validDate(value, optional = false) {
  if (optional && value === '') return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) fail('VALIDATION', '日期格式无效。');
  const parsed = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('VALIDATION', '日期不存在。');
  return value;
}
function validateRecord(input) {
  onlyKeys(input, FIELDS);
  const result = {};
  for (const [key, max] of Object.entries({title:200, note:2000, goal:500, location:200})) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) fail('VALIDATION', '文字格式或长度无效。');
    result[key] = value.trim();
  }
  if (!result.title) fail('VALIDATION', '标题不能为空。');
  result.date = validDate(input.date);
  result.deadline = validDate(input.deadline ?? '', true);
  result.time = input.time ?? '';
  if (typeof result.time !== 'string' || (result.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.time))) fail('VALIDATION', '时间格式无效。');
  result.done = input.done ?? false;
  result.stage = input.stage ?? 0;
  result.duration = input.duration ?? 0;
  if (typeof result.done !== 'boolean' || !Number.isInteger(result.stage) || result.stage < 0 || result.stage > 4 || !Number.isInteger(result.duration) || result.duration < 0 || result.duration > 1440) fail('VALIDATION', '状态、阶段或时长无效。');
  return result;
}
function validateID(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) fail('VALIDATION', '记录编号无效。');
  return id;
}
function validateBackup(input) {
  onlyKeys(input, ['schemaVersion', 'records', 'exportedAt', 'mode']);
  if (input.schemaVersion !== 1 || !Array.isArray(input.records)) fail('VALIDATION', '恢复文件版本或记录格式无效。');
  if (input.records.length > MAX_IMPORT_RECORDS) fail('LIMIT', '云端一次最多恢复 40 条；未导入任何记录，也不会自动分批。');
  if (!input.records.length) fail('VALIDATION', '恢复文件没有可新增的记录。');
  const seen = new Set();
  const records = input.records.map(row => {
    // These are exactly the public backup fields accepted by the local validator.
    // Exported versions/timestamps are permitted metadata, never trusted values.
    onlyKeys(row, ['id', 'entity', ...FIELDS, 'version', 'createdAt', 'updatedAt']);
    if (!ENTITIES.includes(row.entity)) fail('VALIDATION', '恢复文件包含未知模块。');
    const id = validateID(row.id), key = row.entity + ':' + id;
    if (seen.has(key)) fail('VALIDATION', '恢复文件含同模块重复编号；未导入任何记录。');
    seen.add(key);
    const fields = Object.fromEntries(FIELDS.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
    return { id, entity: row.entity, ...validateRecord(fields) };
  });
  return { schemaVersion: 1, records };
}
function publicRecord(row) {
  if (!row || !ENTITIES.includes(row.entity)) fail('INTERNAL', '数据格式异常，请联系维护者。');
  return Object.fromEntries(['id', 'entity', ...FIELDS, 'version', 'createdAt', 'updatedAt'].filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]]));
}
function createService({ repo, getIdentity, clock = () => new Date(), limit = 2000, onError = () => {} }) {
  if (!repo || typeof getIdentity !== 'function') throw new TypeError('Trusted repo and identity adapter required');
  return async function handle(event) {
    try {
      const identity = await getIdentity();
      if (!identity || typeof identity.uid !== 'string' || !identity.uid || identity.anonymous !== false) fail('UNAUTHENTICATED', '请先登录。');
      const uid = identity.uid;
      // Queried on every invocation: revocation is not only a stale JWT claim.
      const authorization = await repo.getAuthorization(uid);
      if (!authorization || authorization.enabled !== true) fail('FORBIDDEN', '此账号尚未获准访问。');
      onlyKeys(event, ['action', 'payload']);
      const { action } = event;
      const payload = event.payload ?? {};
      if (action === 'export') {
        onlyKeys(payload, []);
        const rows = await repo.export(uid);
        if (!Array.isArray(rows) || rows.length > limit) fail('LIMIT', '记录数量超出当前导出上限，未导出不完整文件。');
        const data={schemaVersion:1, exportedAt:clock().toISOString(), records:rows.map(publicRecord)};
        if(Buffer.byteLength(JSON.stringify(data),'utf8')>MAX_EXPORT_BYTES)fail('LIMIT','云端导出超过 4 MiB，请联系维护者；未生成不完整备份。');
        return {ok:true, data};
      }
      if (action === 'import') {
        onlyKeys(payload, ['requestId', 'backup']);
        // Bound the actual UTF-8 request, not JS character count or the size of a
        // client-side file. This endpoint never splits a restore into partial batches.
        if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_IMPORT_BYTES) fail('LIMIT', '云端恢复请求超过 128 KiB；未导入任何记录，也不会自动分批。');
        if (typeof payload.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(payload.requestId)) fail('VALIDATION', '恢复请求编号无效，请重新选择备份。');
        const parsed = validateBackup(payload.backup), now = clock().toISOString();
        const records = parsed.records.map(row => ({ ...row, version: 1, createdAt: now, updatedAt: now }));
        // The repository must atomically reauthorize, create ALL rows and persist
        // its idempotency receipt. A provider without that support fails closed.
        return { ok: true, data: await repo.import(uid, payload.requestId.toLowerCase(), records) };
      }
      onlyKeys(payload, ['entity', 'id', 'version', 'record']);
      const { entity } = payload;
      if (!ENTITIES.includes(entity)) fail('VALIDATION', '未知模块。');
      if (action === 'list') {
        onlyKeys(payload, ['entity']);
        const rows = await repo.list(uid, entity);
        if (!Array.isArray(rows) || rows.length > limit) fail('LIMIT', '记录超过当前列表上限，请联系维护者扩充分页。');
        return {ok:true, data:rows.map(publicRecord)};
      }
      const now = clock().toISOString();
      if (action === 'create') {
        onlyKeys(payload, ['entity', 'id', 'record']);
        const id = validateID(payload.id ?? randomUUID());
        const input = validateRecord(payload.record);
        const row = {id, entity, ...input, version:1, createdAt:now, updatedAt:now};
        return {ok:true, data:publicRecord(await repo.create(uid, entity, row))};
      }
      const id = validateID(payload.id);
      const version = payload.version;
      if (!Number.isSafeInteger(version) || version < 1) fail('VALIDATION', '记录版本无效，请刷新。');
      if (action === 'update') {
        onlyKeys(payload, ['entity', 'id', 'version', 'record']);
        const patch = {...validateRecord(payload.record), version:version + 1, updatedAt:now};
        return {ok:true, data:publicRecord(await repo.update(uid, entity, id, version, patch))};
      }
      if (action === 'remove') {
        onlyKeys(payload, ['entity', 'id', 'version']);
        await repo.remove(uid, entity, id, version);
        return {ok:true, data:true};
      }
      fail('VALIDATION', '未知操作。');
    } catch (error) {
      const messages = {
        CONFLICT:'记录已修改、已删除或编号已存在，请刷新后重试。',
        NOT_FOUND:'记录不存在或不可访问。',
        FORBIDDEN:'此账号尚未获准访问，未执行恢复。',
        LIMIT:'记录数量超出当前限制，未返回不完整结果。'
      };
      if (error instanceof ServiceError) return {ok:false, error:{code:error.code, message:error.message}};
      if (Object.hasOwn(messages, error.code ?? '')) return {ok:false, error:{code:error.code, message:messages[error.code]}};
      // Minimal server-only diagnostics: never log messages, payloads, account IDs,
      // tokens or stacks. SDK error codes help distinguish configuration failures.
      try{onError({code:typeof error.code==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(error.code)?error.code:'UNKNOWN',type:['TypeError','Error','CloudbaseError','TCBError'].includes(error.name)?error.name:'Error'});}catch{}
      // Never expose DB errors, tokens, stack traces, account IDs or request bodies.
      return {ok:false, error:{code:'UNAVAILABLE', message:'服务暂时不可用，操作结果未确认。请重新查询后再试。'}};
    }
  };
}
module.exports = { createService, validateRecord, validateBackup, publicRecord, ENTITIES, FIELDS, ServiceError, MAX_IMPORT_RECORDS, MAX_IMPORT_BYTES, MAX_EXPORT_BYTES };
