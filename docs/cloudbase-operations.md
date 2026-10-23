# CloudBase 运行与安全操作记录

本文件可公开。只记录部署流程、虚构示例与安全边界，不记录真实邮箱、手机号、密码、恢复资料、令牌或管理员密钥。

## 当前选择与发布门槛

本项目采用 **CloudBase 传统模式的文档型数据库** 作为当前适配目标。它使用集合、文档和文档安全规则；不使用 PostgreSQL 模式的表或 SQL RLS，也不将 Supabase 策略直接复制过来。若实际免费环境只提供其他模式，应停止该环境部署并重新评估，不能静默混用权限模型。

六个业务模块通过同一受保护的云函数服务进行增删改查。浏览器不直接读写私人数据库；服务端必须验证平台可信身份、管理员维护的授权名单和记录归属。由于服务端 SDK 具有管理访问能力，客户端拒绝规则不能代替云函数内的授权。

真实云端环境、登录流程及部署权限未全部完成验收前，私人入口保持未配置/不可用状态，不能回退为“模拟登录成功”。演示站保持独立，只加载虚构种子与内存仓储。

## 免费环境与费用限制

经 2026-10-22 查询，腾讯云价格文档描述每账号一个免费体验环境、每月 3,000 资源点，可能需要兑换码；六个月手动续期，且免费体验环境不支持资源包和按量付费。它不是永久无限配额生产服务。

当前创建环境文档另使用“个人版免费期”的表述，因此控制台实际显示的套餐、到期方式、自动续费、超额按量与关联产品费用必须逐项确认，不能将所有“免费试用”都视为无后续账单的同一种套餐。

本任务的严格约束：

- 仅允许明确的免费测试环境，确认总价为零且未开启按量付费、自动付费升级或自动续费。
- 不绑定付款方式，不充值，不买资源包，不创建付费个人版或额外收费附属产品。
- 免费额度不足时停止测试并保留记录，不自动升级。已有其他环境不因名额不足被删除。
- 资源用量告警是提醒而非费用硬上限。可核实平台默认的低资源余额提醒，并设置可用的零支出边界；不能用“有提醒”代替确认计费开关。
- 正式生产的套餐、域名、邮件/短信、备份与超额费用必须另由用户批准。

公开页目前显示个人版限时价格 ¥19.9/月，但这不构成本项目开通授权；实际价格与权益以官方购买页为准。

依据：[资源点价格文档](https://cloud.tencent.com/document/product/876/127357)、[套餐及资源包说明](https://cloud.tencent.cn/document/product/876/136006)、[创建环境指引](https://docs.cloudbase.net/quick-start/create-env)、[公开定价](https://www.cloudbase.net/pricing)。

## 必须由本人处理的节点

代理可以完成代码、依赖、只读诊断和获准的免费环境配置，但以下具体步骤交给用户本人完成：

1. 腾讯云登录、扫码、验证码及本人掌握的凭据输入；不要求将凭据粘贴到聊天。
2. 平台要求的实名认证；资料直接交官方流程，不记录到代码、测试日志或截图报告。
3. 首次服务条款的接受和服务角色权限授权。代理先说明所需权限及作用，由本人在官方界面确认；不静默勾选。
4. CLI 设备码授权。代理可以启动官方 `tcb login`；用户在官方授权页核验用途、权限并完成授权。登录态留在 CLI 的正常安全存储中，不拷贝进仓库。
5. 任何付款、充值、绑定付款方式、按量计费或扩大套餐能力，均需单独取得明确批准；本轮默认禁止。

官方 CLI 使用设备码授权，可支持代理/远程终端，无需聊天中传 `SecretId`、`SecretKey`。不要使用长期账号级云 API key 替代本可通过浏览器完成的登录。[CLI 安装与认证](https://docs.cloudbase.net/cli-v1/install)

## 配置与工具

官方 CLI 包为 `@cloudbase/cli`。依赖应固定版本并从 HTTPS 官方包源安装到隔离工具目录，避免改变用户全局工具。部署前先核实当前 `--help` 与官方配置格式，不能照旧教程猜字段。

仓库只提供 `cloudbaserc.example.json`，它不是 CLI 默认读取的配置文件，`envId` 是占位值且函数数组为空，不会自动部署。只有选定经过核验的测试环境、实际函数目录与版本后，才创建本地 `cloudbaserc.json`；任何秘密不得进入该文件。

`envId` 属于公开路由标识，不是授权凭据，但示例不填实际用户环境。不要把管理员密钥或登录态写入 `envVariables` 的公开配置。平台可用的运行时、实际 handler 和依赖安装行为应与本次锁定的 CLI/SDK 核实后配置。

国内 HTTP API 基址为 `https://{envId}.api.tcloudbasegateway.com`；海外环境有不同域名。文档站或控制台能打开，不证明这个实际环境的认证、函数或数据库接口可用。[HTTP API 总览](https://docs.cloudbase.net/http-api/basic/overview)、[CLI 配置](https://docs.cloudbase.net/en/cli-v1/config)、[云函数配置](https://docs.cloudbase.net/cli-v1/functions/configs)

## 数据库客户端全拒绝

每个传统文档集合，包括授权名单、业务记录及内部状态集合，创建后立即采用客户端全拒绝规则。未证明规则生效前，不放入私人数据。下面是传统文档安全规则，不是 PG RLS：

```json
{
  "read": false,
  "write": false,
  "create": false,
  "update": false,
  "delete": false
}
```

必须在实际环境确认每个集合已使用这些规则；仅在代码目录保存一个 JSON 文件不代表云端已应用。规则可能有生效延迟，应用后等待并用普通客户端验证。

浏览器即使已登录，也不能通过 SDK/HTTP 数据库接口直接读取数据。云函数管理端仍可访问数据库，所以它必须独立检查：

- 从平台提供且经服务端验证的身份上下文取用户 ID，不能使用前端 `userId`、`ownerId` 或客户端自称的管理员标记。
- 授权名单只由受控管理员维护，普通业务 API 没有新增/修改名单的动作。
- 每次请求都核验账号未被停用，且为非匿名、有效会话。
- 每次读取和修改使用可信用户 ID 约束归属。新增由服务端写归属，不接受客户端转移；更新只能修改字段白名单。
- 公开函数入口仅允许具体业务动作，不接受任意集合名、查询表达式、SQL、管理员 SDK 方法或通用代理转发。
- 版本检查与事务用于防止并发覆盖；UUID/幂等标识用于重复提交；读取分页限制和查询白名单用于控制消耗。
- 记录有限错误代码和请求编号，不记录完整私人标题、请求体、密码或 token。

不能仅因为函数用了 `@cloudbase/node-sdk` 就宣称身份认证可靠；必须验证该函数调用链的身份上下文来源，并用真实无令牌/伪造归属/第二账号请求测试。HTTP 函数不得直接信任未经验证的 Authorization header 或请求体中的身份。

官方依据：[传统数据库安全规则](https://docs.cloudbase.net/database/security-rules)、[规则示例及管理员绕过说明](https://docs.cloudbase.net/rule/rule-example)。

## 账号、网络与正式上线门槛

只允许经过服务器名单批准的个人账号；关闭或不提供不需要的公开注册和匿名登录。网页隐藏注册按钮不等于服务端阻止注册，也不等于阻止未批准账号访问业务数据。

发布前必须用实际环境分别验证：登录、用户级读取、创建后重新读取、更新/删除、未登录拒绝、未批准账号拒绝、A/B账号互不可见、伪造归属拒绝、会话到期/退出、重复提交和并发冲突。测试数据只能为虚构内容。

网络验收区分 Mac 当前网络直连、iPhone Wi-Fi、iPhone 蜂窝与代理路径；桌面移动视口不能冒充真实 iPhone 蜂窝测量。每条测试标明是否经过代理、是否仅测入口、是否获得真实后端响应。

若 GitHub Pages 可用，可先保留作为公开演示；如果需要国内前端托管，再评估 CloudBase 静态托管。默认域名有中间提示/响应限制，只适合测试；正式自定义域名应符合当前 ICP 备案条件。域名、备案或付费无法完成时，不把测试入口宣称为长期稳定生产入口。[默认域名限制](https://docs.cloudbase.net/service/alias)、[静态托管](https://docs.cloudbase.net/hosting/quick-start)

## 部署、版本和回滚

1. 记录当前演示站的 Git 提交与发布来源；独立分支开发，保留原入口和 Supabase 项目。
2. 先部署独立测试环境。确认免费计划和权限，不覆盖原演示工作台；使用虚构数据完成完整安全测试。
3. 部署清单必须写明目标环境、数据库模式、函数名/版本、客户端配置、规则状态及测试结果。操作前核对当前 CLI 默认环境，尽可能显式传目标 ID。
4. 逐项审查 Git diff、忽略规则、构建产物和依赖锁文件；提交身份使用已配置的 GitHub noreply 邮箱。
5. 未通过云端权限测试时，私人数据入口维持未配置/停用状态；本地模拟通过不作为生产放行理由。
6. 生产发布使用可追踪提交/标签和不可混淆的前后端版本记录。新增结构优先兼容旧代码，不执行不可逆破坏性迁移。
7. 回滚先停止或锁定私人写入入口，再把前端恢复到已知提交，并按发布清单恢复对应云函数版本和配置；复测权限后开放。仅回滚前端不能恢复已变更的数据或数据库规则。
8. 数据恢复先在隔离环境演练。恢复时不临时开放匿名访问；备份/导出保存在受保护位置，不进仓库。普通界面不提供“清空数据库”按钮。
9. 若问题涉及密钥泄漏，立即撤销/轮换受影响凭据并检查日志；删除 Git 文件或回滚不能撤销已经泄露的密钥。

以上为运行规程，不代表任何环境已经部署或测试成功。实际环境 ID、运行结果和回滚版本由最终验收报告记录，不在本文件中虚构。

## CLI 3.8.7 实机帮助核对（2026-10-22）

以下命令通过本机已安装的 CloudBase CLI 3.8.7 的 `--help` 核对；这里只列模板，不包含实际环境、用户或密码。运行版本不同时重新看帮助。命令通常还应显式指定 `-e` 与 `-r ap-shanghai`，避免误用默认环境。

### 只读环境与计费

```sh
tcb env list --region ap-shanghai --json
tcb env detail -e ENV_ID --json
tcb env usage -e ENV_ID --json
tcb env info -e ENV_ID --type FLEXDB,SCF,Auth --json
tcb env login get -e ENV_ID --json
tcb api tcb DescribeBillingInfo --api-version 2018-06-08 --body '{"EnvId":"ENV_ID"}' --json
```

`env info` 用于指标，不代替套餐核实。计费接口返回中的 `EnableOverrun` 应为 false（明确表示未开启超额转按量）、`IsAutoRenew` 应为 false；同时核对 `PackageId`、`FreeQuota`、`IsAlwaysFree`、`ExpireTime` 和账户实际购买记录。`PREPAYMENT` 本身不能证明免费，单个字段缺失时也不能假定为 false。[计费查询](https://cloud.tencent.com/document/product/876/94390)、[计费字段定义](https://cloud.tencent.com/document/product/876/34822)

CLI 没有在本次帮助中提供资源点告警编辑命令；不得猜造命令。免费 cap 通过实际套餐与 `EnableOverrun=false` 核实，默认低资源余额告警及收件设置在官方控制台检查。未核实的告警不能写成“已配置”。

### 部署事件型云函数

```sh
tcb fn deploy FUNCTION_NAME --dir FUNCTION_DIR --runtime Nodejs20.19 --install-dependency false -e ENV_ID -r ap-shanghai
```

真实命令为 `fn`，不是 `functions`。省略 `--httpFn` 时默认事件型函数；不要添加 `--httpFn`、`--path` 或 `--ws`，以免自动创建 HTTP 访问路径/其他函数类型。运行时参数仅首次部署生效。依赖已在本地安装或打包时使用 `--install-dependency false`；部署前核实打包内容与忽略规则。

`--force` 会覆盖同名函数，不把它作为所有部署的默认参数。只有核实目标是本项目可替换函数并保留旧版本后，才考虑使用。`--all` 是批量部署，不用于首次最小验证。

版本相关帮助已核对：

```sh
tcb fn publish-version FUNCTION_NAME RELEASE_DESCRIPTION -e ENV_ID
tcb fn list-function-versions FUNCTION_NAME -e ENV_ID
tcb fn get-route FUNCTION_NAME -e ENV_ID
tcb fn config-route FUNCTION_NAME VERSION TRAFFIC -e ENV_ID
```

发布版本和路由的可用性须在目标环境确认，不能只因帮助存在就声称已具有回滚版本。部署首次要求的服务角色/CAM 权限由本人在官方流程授权，不为解决权限错误私自授予整个账号管理员策略。

### 集合创建即全拒绝

CLI 数据库命令是 `db nosql`，而不是 `database`。`db nosql execute --command` 接受 MgoCommands JSON，适用于受控文档数据操作；不是 SQL，也不是安全规则配置命令。不要把网页客户端传入的 MgoCommands 转交给它执行。

创建集合可使用官方通用云 API `CreateTable`，API 版本 2018-06-08。应将 `PermissionInfo.AclTag` 设为 `ADMINONLY`，与环境 ID 一起提交，在创建时就拒绝客户端权限。以下只是模板，执行前必须确认真实环境、传统模式及集合不存在：

```sh
tcb api tcb CreateTable --api-version 2018-06-08 --region ap-shanghai --body '{"EnvId":"ENV_ID","TableName":"COLLECTION_NAME","PermissionInfo":{"EnvId":"ENV_ID","AclTag":"ADMINONLY"}}' --json
```

`CreateTable` 的正式输入允许 `PermissionInfo`，其 `ADMINONLY` 表示仅管理员访问。Tag/连接器字段只在目标环境确需时依据接口与实际实例填写，不猜测或混用其他数据库连接器。[CreateTable](https://cloud.tencent.cn/document/api/876/127968)、[PermissionInfo 定义](https://cloud.tencent.com/document/product/876/34822)

已存在集合可通过官方 `ModifyDatabaseACL` 设为 `ADMINONLY`。需要自定义全拒绝规则时，管理 SDK 官方接口为 `commonService().call` 的 `ModifySafeRule`，参数包括 `EnvId`、`CollectionName`、`AclTag: CUSTOM` 和 JSON 字符串形式的 `Rule`。这类配置由受控管理工具执行，不将管理员秘密写入脚本。应用后必须检查云端实际规则并用普通客户端验证。[权限管理 API](https://docs.cloudbase.net/api-reference/manager/node/rule)、[ModifyDatabaseACL](https://cloud.tencent.com/document/product/876/34819)

重要：CLI 3.8.7 的 `permission` 已退役；`policy set` 用于网关 OPA Rego，帮助明确警告“保存后立即禁用旧网关授权”。它不是上述文档集合安全规则的同义入口，不为设置数据库客户端全拒绝而运行 `policy set`。

### 账号密码提供商与用户准备

已核对的配置选项：

```sh
tcb env login set -e ENV_ID --username-login true --anonymous-login false --email-login false --phone-number-login false --json
tcb user create --help
```

`env login set` 应先读取现有配置，保留未明确修改的安全设置；不随意改变已启用的 MFA。用户名密码登录开关不等于服务端授权名单，也不能证明公开注册已禁用。只有服务端名单批准的用户才可以调用私人业务 API。

`tcb user create NAME` 的帮助包含 `--uid`、`--password`、`--type internalUser/externalUser`、`--status ACTIVE/BLOCKED` 等参数，默认类型是 internalUser。应用测试用户应先核实目标认证模型和类型，不能仅因默认值能创建就把它当成正确应用身份。

本版本帮助未列出 `--password-stdin`。不能让用户提供密码后拼入命令行，因为参数可能出现在调用日志/进程列表。本人账号密码由官方界面本人设置；自动化虚构测试账号如需随机密码，应通过受控管理程序在内存生成并直接调用管理 API，不打印秘密，不写仓库，不在公开报告中保存。不通过匿名或公开注册来绕开受控创建流程。
