# CloudBase 服务端适配边界

当前状态：已部署到上海免费试用环境，真实云端权限、读写、并发及恢复已通过检查，见 [云端验收记录](../docs/cloud-acceptance.md)。本地 mock 不替代真实平台测试。

## 选定模式

仅适用于传统环境的**文档型数据库**，不适用于 CloudBase PG 模式。PG 模式需要独立的 SQL GRANT/RLS 方案，不能应用本目录的文档集合规则。

锁定官方统一 SDK `@cloudbase/js-sdk` 为 `3.10.3`。该版本于 2026-10-22 通过 npm 官方注册表核对；不是将搜索缓存中的 3.4.x 当作最新版本。安装应生成并检查 lockfile，不使用浮动 CDN 版本。

## 云函数配置（部署前要求，不含任何真实值）

- 名称与规则一致：`mdwPrivateApi`；常规事件型云函数入口 `index.main`，代码目录 `backend/`。
- 环境变量：`MDW_CLOUDBASE_ENV_ID` 必须显式设置为目标环境；`MDW_CLOUDBASE_REGION` 可显式指定已创建的大陆区域。
- 通过 CloudBase SDK 的受认证 `callFunction` 通道调用，不公开不鉴权的 HTTP 触发器。
- 不能在代码设置个人 SecretId、SecretKey 或管理 accessKey。平台运行时提供的管理凭据只供服务端 SDK 使用，不输出到响应或日志。
- 代码读取 `cloudbase.getCloudbaseContext(context).TCB_UUID` 和匿名标记，拒绝缺失/匿名身份。前端 `event.uid`、`owner_id`、`event.userInfo` 均不是身份来源。
- `TCB_ISANONYMOUS_USER` 必须明确为布尔 false 或字符串 `false`；缺失、未知或与匿名 loginType 冲突时拒绝。若目标运行时未提供该标记，先保持服务关闭并核对官方运行时契约，不把缺失解释为已验证非匿名。
- 每次调用都查询 `mdw_authz`，只有对应 `uid` 与严格布尔 `enabled:true` 才授权。文档 ID 由 `authorizationKey(uid)` 生成，管理员在可信管理流程配置；不能从浏览器维护授权名单。

`security-rules.document.json` 是“集合名 → 规则”的部署清单，不是可以不经转换直接提交到任意平台接口的统一配置格式。需要分别把对应规则应用到 `mdw_records` 和 `mdw_authz` 集合，并实际验证匿名和已登录的直接数据库请求均被拒绝。

文档集合规则不约束拥有管理能力的云函数，所以云函数内部的名单、owner_id、字段校验与版本检查是必需的；规则文件不是这些检查的替代。

函数规则中的 `auth.loginType != 'ANONYMOUS' && auth != null` 是官方明确列出的支持值/预设表达式，并非任意可编程表达式。官方不支持在这里自行加入 UID 白名单等复杂条件，故指定用户名单仍由函数服务层检查。

## 并发与数据边界

- 创建使用 add 与由用户/模块/业务编号派生的唯一 `_id`，不使用 set/upsert。编号重复且内容一致时仅返回原记录；内容不同则拒绝。
- 更新/删除使用一个条件写操作，条件同时包含 `_id`、owner_id、entity、id 和预期 version。只有受影响行数严格为 1 才报告成功；缺少明确计数的响应失败关闭。
- 查询以 100 条为批次遍历；列表默认最多 1000 条，超限报错，不悄悄截断。导出适配器最多 10000 条，业务 service 还可施加更低限制。
- 导出跨多次查询并非数据库一致性快照。大规模导出或导出期间编辑的数据一致性需在正式环境另行评估；不冒充完整数据库灾备。

## 验收清单

下面 1—5 项及第 7 项当前 Mac 直连已验收；第 6 项目前只有本地分页测试，真实大数据量与真实 iPhone 网络仍需单独验证。

1. 固定 SDK 在目标 runtime 能否解析可信请求 uid，并正确拒绝匿名/缺失上下文。
2. 网关函数权限是否只允许显式登录；认证注册配置与服务端名单是否按预期限制账号。
3. 两个已授权测试账号互不可见、无法改写归属；未授权账号不能操作。
4. 直接数据库请求全部拒绝；使用正常用户不能修改 authz。
5. 云端同时更新同一版本的两请求仅一个成功；写入返回值确实为文档型数据库 updated/deleted 字段。
6. 存在至少 205 条虚构记录时，列表及导出跨批读取无遗漏。
7. 当前 Mac 直连、iPhone 实机 Wi-Fi/蜂窝认证和读写；不以桌面模拟代替。

## 官方依据

- [传统模式与 PG 权限区别](https://docs.cloudbase.net/authentication-v2/auth/auth-control)
- [Web v3 身份认证和 Node 上下文](https://docs.cloudbase.net/api-reference/webv3/authentication)
- [文档型数据库接口](https://docs.cloudbase.net/api-reference/webv3/database)
- [云函数调用](https://docs.cloudbase.net/api-reference/webv3/functions)
- [函数安全规则限制](https://docs.cloudbase.net/cloud-function/security-rules)
- [文档数据库安全规则](https://docs.cloudbase.net/database/security-rules)
- [npm 官方版本元数据](https://registry.npmjs.org/@cloudbase/js-sdk/latest)
