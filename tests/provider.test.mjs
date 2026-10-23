import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../private/provider.js',import.meta.url),'utf8');
const uri=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
async function make(options={}){
  const marker=crypto.randomUUID();
  const mock=`
    let session=${options.session?'true':'false'};
    const user={is_anonymous:${options.anonymous===undefined?'false':JSON.stringify(options.anonymous)}};
    export default {init(config){if(config.persistence!=='none')throw Error('must be memory');return {
      auth(){return {async getSession(){return {data:{session:session?{user}:null,user}}},async signInWithPassword(){session=true;return {data:{session:{user},user}}},async signOut(){session=false;return {data:{}}}}},
      async callFunction(request){if(request.parse!==true)throw Error('parse must be explicit');${options.errorCode?"throw Object.assign(Error('fake-sensitive-sdk-detail'),{code:"+JSON.stringify(options.errorCode)+"})":options.networkError?"throw Error('fake-sensitive-sdk-detail')":"return {result:"+JSON.stringify(options.response??{ok:true,data:[]})+"}"}}
    }}}; // ${marker}
  `;
  const configured={enabled:options.enabled!==false,environmentId:'fictional-test-env',region:'ap-shanghai',functionName:'mdwPrivateApi'};
  const transformed=source.replace("import config from './config.public.js';",'const config='+JSON.stringify(configured)+';').replace("'./vendor/cloudbase.js'",JSON.stringify(uri(mock)));
  return (await import(uri(transformed))).createProvider();
}
test('unconfigured private mode fails before SDK initialization',async()=>{await assert.rejects(make({enabled:false}),e=>e.code==='NOT_CONFIGURED');});
test('memory session, explicit parser, safe session response',async()=>{const p=await make();assert.equal(await p.getSession(),null);await p.signIn({username:'fictional',password:'test-only'});assert.deepEqual(await p.getSession(),{authenticated:true});assert.deepEqual(await p.request('list',{entity:'tasks'}),[]);await p.signOut();assert.equal(await p.getSession(),null);});
test('anonymous identity and unknown anonymous flag cannot log in',async()=>{for(const anonymous of [true,null,'false']){const p=await make({anonymous});await assert.rejects(p.signIn({username:'fictional',password:'test-only'}),e=>e.code==='AUTH_REQUIRED');}});
test('serialized function envelope is safely parsed',async()=>{const p=await make({response:JSON.stringify({ok:true,data:[{id:'fictional'}]})});assert.deepEqual(await p.request('list',{entity:'tasks'}),[{id:'fictional'}]);});
test('malformed function response fails; SDK error details are not echoed',async()=>{const p=await make({response:'not-json'});await assert.rejects(p.request('list'),e=>e.code==='UNAVAILABLE');const q=await make({networkError:true});await assert.rejects(q.request('create'),e=>e.code==='NETWORK'&&!e.message.includes('fake-sensitive'));});
test('server denial locks provider and prevents further requests',async()=>{const p=await make({session:true,response:{ok:false,error:{code:'FORBIDDEN',message:'没有权限'}}});await assert.rejects(p.request('list'),e=>e.code==='FORBIDDEN');assert.equal(await p.getSession(),null);await assert.rejects(p.request('list'),e=>e.code==='AUTH_REQUIRED');});
test('gateway authentication exceptions clear cached session and lock further calls',async()=>{for(const errorCode of ['CHECK_LOGIN_FAILED','ACCESS_TOKEN_EXPIRED','refresh_token_expired','unauthenticated','permission_denied']){const p=await make({session:true,errorCode});await assert.rejects(p.request('list'),e=>e.code==='AUTH_REQUIRED'&&!e.message.includes('fake-sensitive'));assert.equal(await p.getSession(),null);await assert.rejects(p.request('list'),e=>e.code==='AUTH_REQUIRED');}});
