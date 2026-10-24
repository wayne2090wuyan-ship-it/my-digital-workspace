// Public configuration only. Real-cloud safety tests are recorded in
// docs/cloud-acceptance.md. Set enabled:false to lock the private entry point.
// Environment IDs identify services; they are not admin credentials.
export default Object.freeze({
  enabled: false,
  disabledReason: '后台读写与权限测试已完成。但当前免费套餐不允许把此 GitHub Pages 域名加入登录来源，因此这里暂不开放私人登录。你无需重新注册账号或修改密码；公开虚构演示仍可使用。',
  environmentId: 'mdw-private-test-d3eilmu4efb587e',
  region: 'ap-shanghai',
  functionName: 'mdwPrivateApi'
});
