'use strict';

const { createCloudbaseRepository } = require('./cloudbase-repository.cjs');
const reject = (code, message) => ({ ok: false, error: { code, message } });

function createEntrypoint({ sdk, environmentId, region = 'ap-shanghai', serviceFactory }) {
  return async function main(event, context) {
    if (!environmentId || typeof environmentId !== 'string') return reject('CONFIGURATION_ERROR', '私人服务尚未配置');
    let runtime;
    try { runtime = sdk.getCloudbaseContext(context); } catch { return reject('UNAUTHORIZED', '无法核验登录状态'); }
    const uid = runtime?.TCB_UUID;
    const loginType = String(runtime?.LOGINTYPE || '').toUpperCase();
    const anonymousFlag = runtime?.TCB_ISANONYMOUS_USER;
    const anonymous = anonymousFlag === 'true' || anonymousFlag === true || loginType === 'ANONYMOUS';
    const explicitlyNonAnonymous = anonymousFlag === 'false' || anonymousFlag === false;
    // A missing or unknown anonymous marker is not proof of a permanent identity.
    // Fail closed until the deployed runtime supplies the documented explicit flag.
    if (typeof uid !== 'string' || !uid || anonymous || !explicitlyNonAnonymous) return reject('UNAUTHORIZED', '请先登录授权账号');
    if (runtime.TCB_ENV && runtime.TCB_ENV !== environmentId) return reject('CONFIGURATION_ERROR', '运行环境不匹配');
    try {
      // Per-request instance/context prevents one caller's identity leaking into another request.
      const app = sdk.init({ env: environmentId, region, context, timeout: 15000 });
      const repo = createCloudbaseRepository(app.database());
      const handle = serviceFactory({ repo, getIdentity: () => ({ uid, anonymous: false }), onError: diagnostic => console.warn('MDW_SERVICE_FAILURE', JSON.stringify(diagnostic)) });
      // CloudBase injects tcbContext (Web SDK) / userInfo (mini-program).
      // These are transport metadata, never identity sources. Discard only
      // these fields; preserve other keys so the service rejects unknown input.
      const request = event && typeof event === 'object' && !Array.isArray(event)
        ? Object.fromEntries(Object.entries(event).filter(([key]) => !['userInfo', 'tcbContext'].includes(key)))
        : event;
      return await handle(request);
    } catch {
      // Never return raw SDK errors, access tokens, query payloads or environment variables.
      return reject('BACKEND_ERROR', '服务暂时不可用，请稍后重试');
    }
  };
}

exports.createEntrypoint = createEntrypoint;
exports.main = async (event, context) => {
  if (!process.env.MDW_CLOUDBASE_ENV_ID) return reject('CONFIGURATION_ERROR', '私人服务尚未配置');
  const sdk = require('@cloudbase/js-sdk');
  const { createService } = require('./service.cjs');
  return createEntrypoint({
    sdk,
    environmentId: process.env.MDW_CLOUDBASE_ENV_ID,
    region: process.env.MDW_CLOUDBASE_REGION || 'ap-shanghai',
    serviceFactory: createService
  })(event, context);
};
