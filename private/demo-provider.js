// This provider is intentionally isolated: no network, account, token or persistent browser storage.
export const entities = ['tasks','events','papers','academic','fitness','life'];
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const allowed = ['title','date','time','note','done','stage','goal','deadline','location','duration'];
const clone = x => structuredClone(x);
function failure(code, message) { return Object.assign(new Error(message), {code}); }
export function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('VALIDATION','记录格式无效。');
  for(const key of Object.keys(input)) if(!allowed.includes(key)) throw failure('VALIDATION','记录包含不允许的字段。');
  const out={};
  for(const key of ['title','note','goal','location']) {
    const value=input[key]??'';
    if(typeof value!=='string' || value.length>({title:200,note:2000,goal:500,location:200}[key])) throw failure('VALIDATION','文字长度或格式无效。');
    out[key]=value.trim();
  }
  if(!out.title) throw failure('VALIDATION','请填写标题。');
  for(const key of ['date','deadline']) {
    const value=input[key]??'';
    if(typeof value!=='string') throw failure('VALIDATION','日期格式无效。');
    if(value){
      const parsed=new Date(value+'T12:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==value) throw failure('VALIDATION','日期无效。');
    }
    if(key==='date'&&!value) throw failure('VALIDATION','请填写日期。');
    out[key]=value;
  }
  out.time=input.time??'';
  if(typeof out.time!=='string'||(out.time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.time))) throw failure('VALIDATION','时间格式无效。');
  out.done=input.done??false;if(typeof out.done!=='boolean') throw failure('VALIDATION','完成状态无效。');
  out.stage=input.stage??0;if(!Number.isInteger(out.stage)||out.stage<0||out.stage>4) throw failure('VALIDATION','阶段无效。');
  out.duration=input.duration??0;if(!Number.isInteger(out.duration)||out.duration<0||out.duration>1440) throw failure('VALIDATION','时长无效。');
  return out;
}
export function validateBackup(data) {
  if(!data||data.schemaVersion!==1||!Array.isArray(data.records)||data.records.length>2000) throw failure('VALIDATION','恢复文件版本无效，或记录超过 2000 条。');
  if(Object.keys(data).some(key=>!['schemaVersion','records','exportedAt','mode'].includes(key))) throw failure('VALIDATION','恢复文件包含不允许的顶层字段。');
  const ids=new Set();
  const records=data.records.map(item=>{
    if(!item||!entities.includes(item.entity)||typeof item.id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(item.id)||ids.has(item.entity+':'+item.id)) throw failure('VALIDATION','记录类型或同模块编号无效/重复。');
    ids.add(item.entity+':'+item.id);
    // Ignore no unknown fields: a backup may never smuggle ownership or session credentials.
    const backupFields=['id','entity','version','createdAt','updatedAt',...allowed];
    if(Object.keys(item).some(key=>!backupFields.includes(key))) throw failure('VALIDATION','文件含不允许恢复的字段。');
    const input=Object.fromEntries(allowed.filter(key=>key in item).map(key=>[key,item[key]]));
    return {id:item.id,entity:item.entity,...validateRecord(input)};
  });
  return {schemaVersion:1,records};
}
export function createDemoProvider() {
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
  function seed(){return entities.map((entity,i)=>({id:`demo-${entity}`,entity,...validateRecord({title:['示例任务：整理研究笔记','示例日程：阅读时段','虚构课题：数字规则研究','示例论坛工作：整理议程','示例健身：舒展练习','示例生活：整理书桌'][i],date:today,stage:entity==='papers'?1:0,duration:entity==='fitness'?15:0}),version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));}
  let records=seed();
  return {
    mode:'demo',async getSession(){return {demo:true};},async signIn(){throw failure('DEMO','演示版不登录。');},async signOut(){records=[];},
    async request(action,payload={}) {
      if(action==='export')return {schemaVersion:1,exportedAt:new Date().toISOString(),mode:'demo',records:clone(records)};
      if(action==='reset'){records=seed();return true;}
      if(action==='import'){
        const parsed=validateBackup(payload.backup);
        if(parsed.records.some(item=>records.some(r=>r.entity===item.entity&&r.id===item.id)))throw failure('CONFLICT','恢复文件含同模块已有编号；未导入任何记录。');
        const now=new Date().toISOString();records.push(...parsed.records.map(r=>({...r,version:1,createdAt:now,updatedAt:now})));return {count:parsed.records.length};
      }
      if(!entities.includes(payload.entity))throw failure('VALIDATION','未知模块。');
      if(action==='list')return clone(records.filter(r=>r.entity===payload.entity));
      if(action==='create'){
        const record=validateRecord(payload.record);const now=new Date().toISOString();
        const id=payload.id||crypto.randomUUID();
        if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(id))throw failure('VALIDATION','记录编号无效。');
        const existing=records.find(r=>r.entity===payload.entity&&r.id===id);
        if(existing){
          if(existing.entity===payload.entity&&allowed.every(key=>existing[key]===record[key]))return clone(existing);
          throw failure('CONFLICT','该编号已存在且内容不同，请刷新确认；没有新增重复记录。');
        }
        const row={...record,id,entity:payload.entity,version:1,createdAt:now,updatedAt:now};records.push(row);return clone(row);
      }
      const index=records.findIndex(r=>r.entity===payload.entity&&r.id===payload.id);
      if(index<0||records[index].version!==payload.version)throw failure('CONFLICT','记录已被修改或删除，请刷新后重试。');
      if(action==='remove'){records.splice(index,1);return true;}
      if(action==='update'){records[index]={...records[index],...validateRecord(payload.record),version:records[index].version+1,updatedAt:new Date().toISOString()};return clone(records[index]);}
      throw failure('VALIDATION','未知操作。');
    }
  };
}
