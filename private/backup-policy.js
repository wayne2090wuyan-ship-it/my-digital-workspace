import {validateBackup,MAX_BACKUP_BYTES} from './demo-provider.js';

// Keep these transport limits aligned with the reviewed service contract.
// A file may contain harmless whitespace, so restore is bounded again after
// validation by the complete UTF-8 import envelope sent to the service.
export const MAX_CLOUD_RESTORE_RECORDS=40;
export const MAX_CLOUD_RESTORE_BYTES=128*1024;
export const MAX_CLOUD_EXPORT_BYTES=4*1024*1024;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function buildRestoreRequest(mode,backup,requestId){
  const parsed=validateBackup(backup);
  if(mode==='demo')return {backup:parsed};
  if(mode!=='cloud')fail('VALIDATION','未知恢复模式，未执行恢复。');
  if(!parsed.records.length)fail('VALIDATION','文件中没有可恢复的记录。');
  if(parsed.records.length>MAX_CLOUD_RESTORE_RECORDS)fail('LIMIT','云端一次最多恢复 40 条；未导入，也不会自动分批。');
  if(typeof requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId))fail('VALIDATION','恢复请求编号无效，请重新选择文件。');
  const payload={requestId,backup:parsed};
  const bytes=new Blob([JSON.stringify({action:'import',payload})]).size;
  if(bytes>MAX_CLOUD_RESTORE_BYTES)fail('LIMIT','云端恢复请求超过 128 KiB；未导入，也不会自动分批。');
  return payload;
}
export function exportByteLimit(mode){
  if(mode==='cloud')return MAX_CLOUD_EXPORT_BYTES;
  if(mode==='demo')return MAX_BACKUP_BYTES;
  fail('VALIDATION','未知导出模式。');
}
