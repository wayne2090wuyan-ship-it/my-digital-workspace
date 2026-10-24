import config from './config.public.js';
const failure=(code,message)=>Object.assign(new Error(message),{code});
function check(result){
  if(result?.error)throw failure('AUTH_REQUIRED','认证失败或会话已过期，请重新登录。');
  return result?.data;
}
export async function createProvider(){
  if(config.enabled!==true||!config.environmentId)throw failure('NOT_CONFIGURED',typeof config.disabledReason==='string'?config.disabledReason:'云环境尚未通过安全验收，私人模式保持锁定。可先体验虚构演示。');
  if(!/^[a-zA-Z0-9-]{3,100}$/.test(config.environmentId)||!/^mdwPrivateApi$/.test(config.functionName))throw failure('NOT_CONFIGURED','公开配置格式无效。');
  const {default:cloudbase}=await import('./vendor/cloudbase.js');
  const app=cloudbase.init({env:config.environmentId,region:config.region,persistence:'none',timeout:15000,debug:false});
  const auth=app.auth({persistence:'none'});
  let locked=false;
  return {
    mode:'cloud',
    async getSession(){
      if(locked)return null;
      try{const data=check(await auth.getSession());const user=data?.user??data?.session?.user;if(!data?.session||user?.is_anonymous!==false)return null;return {authenticated:true};}
      catch{locked=true;return null;}
    },
    async signIn({username,password}){
      locked=true;
      // No registration or automatic user creation. Login credentials are never
      // logged, exported or saved by application code.
      try{const data=check(await auth.signInWithPassword(username.includes('@')?{email:username,password}:{username,password}));const user=data?.user??data?.session?.user;if(!data?.session||user?.is_anonymous!==false)throw new Error('No verified non-anonymous session');locked=false;}
      catch{throw failure('AUTH_REQUIRED','登录未成功，请检查账号、密码或网络；不要重复快速提交。');}
    },
    async signOut(){locked=true;const result=await auth.signOut();check(result);},
    async request(action,payload={}){
      if(locked)throw failure('AUTH_REQUIRED','当前页面已锁定，请重新登录。');
      let result;
      try{result=await app.callFunction({name:config.functionName,data:{action,payload},parse:true});}
      catch(error){
        const code=String(error?.code||'').toUpperCase();
        const expired=['UNAUTHENTICATED','UNAUTHORIZED','AUTH_REQUIRED','SESSION_EXPIRED','CHECK_LOGIN_FAILED','ACCESS_TOKEN_EXPIRED','TOKEN_EXPIRED','REFRESH_TOKEN_EXPIRED','INVALID_REFRESH_TOKEN','REFRESH_TOKEN_EXHAUSTED','INVALID_CREDENTIALS','PERMISSION_DENIED'];
        if(expired.includes(code)||error?.status===401||error?.statusCode===401){locked=true;try{await auth.signOut();}catch{}throw failure('AUTH_REQUIRED','登录状态已失效或访问被拒绝，请重新登录。');}
        throw failure('NETWORK','无法确认服务响应，请刷新查询后再决定是否重试。');
      }
      let response=result?.result;
      if(typeof response==='string'){
        if(response.length>8*1024*1024)throw failure('LIMIT','服务响应超出安全大小。');
        try{response=JSON.parse(response);}catch{throw failure('UNAVAILABLE','服务返回格式无效，操作结果未确认。');}
      }
      if(!response||response.ok!==true){
        const code=response?.error?.code||'UNAVAILABLE';
        if(['UNAUTHENTICATED','UNAUTHORIZED','FORBIDDEN','AUTH_REQUIRED','SESSION_EXPIRED'].includes(code)){locked=true;try{await auth.signOut();}catch{/* Do not mask authorization failure. */}}
        const allowed=['UNAUTHENTICATED','UNAUTHORIZED','FORBIDDEN','AUTH_REQUIRED','SESSION_EXPIRED','CONFLICT','VALIDATION','NOT_FOUND','LIMIT','UNSUPPORTED','UNAVAILABLE','CONFIGURATION_ERROR'];
        throw failure(allowed.includes(code)?code:'UNAVAILABLE',typeof response?.error?.message==='string'?response.error.message:'私人服务暂时不可用，操作结果未确认。');
      }
      return response.data;
    }
  };
}
