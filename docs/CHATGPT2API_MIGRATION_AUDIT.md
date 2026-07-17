# ChatGPT2API -> image2api 迁移审计

更新日期：2026-07-17

## 结论

image2api 应作为长期核心：它已经具备 PostgreSQL、Redis、RustFS、多供应商账号池、模型级定价、失败切换、用户/API Key、支付、CDK、代理、并发分组和完整管理后台。迁移时应补协议兼容，不应把 ChatGPT2API 的单供应商实现和本地文件存储重新搬进来。

## 能力矩阵

| 能力 | ChatGPT2API | image2api | 决策 |
|---|---|---|---|
| `/v1/images/generations` | 支持 | 支持 | 保留 image2api 实现 |
| `/v1/images/edits` multipart | 支持 | 支持 | 保留 |
| `/v1/images/edits` JSON/data URL | 支持 | 已补齐 | 远程 URL 暂拒绝，避免 SSRF |
| `/v1/chat/completions` 生图 | 支持 | 已补齐 | 普通/SSE 均支持，10 秒保活 |
| `/v1/responses` image tool | 支持 | 已补齐 | 普通/SSE 均支持 |
| `response_format=url/b64_json` | 支持 | 支持 | image2api API 输出不落 RustFS |
| `quality` 分辨率映射 | 支持 | 已修复透传 | 使用模型实际定价档位钳制 |
| `n=1..4` | 支持 | 当前执行仍以单图为主 | P0：设计批量计费和部分失败语义后实现 |
| `/v1/messages` 文本/工具 | 支持 | 不支持 | 不进核心；image2api 定位是媒体网关 |
| 搜索、PPT、PSD | 支持 | 不支持 | 保持独立服务，不耦合媒体核心 |
| 账号自动注册 | ChatGPT 号池强 | 多供应商导入/刷新强 | Provisioner 独立运行，避免核心依赖 |
| 数据库 | 可 SQLite/中央 PG | PostgreSQL | 使用 image2api |
| 缓存/并发 | 进程内为主 | Redis + 分组并发 | 使用 image2api |
| 图片存储 | 本地盘 | RustFS/S3 | 使用 image2api；API Key 请求默认不落盘 |
| 供应商 | ChatGPT 为主 | Adobe/ChatGPT/Runway/Grok/Leonardo/Krea/Imagine/custom | 使用 image2api |
| 失败切换 | 账号池重试 | 模型别名跨供应商 failover | 使用 image2api |
| 用户/支付/代理 | 基础积分和兑换 | 支付、CDK、代理、邀请、签到 | 使用 image2api |
| 集群控制台 | 原生兼容 | 通过最小机器接口接入 | 已完成双密钥隔离 |

## 后续优先级

### P0：全面替换前必须完成

1. 为 `n>1` 定义批量计费、逐张退款、部分成功返回和总超时，禁止继续静默只返回一张。
2. 统一 OpenAI 错误体，同时保留 `detail`，让 SDK 能稳定读取 `error.message/type/code`。
3. 为同步 API 增加客户端断线策略：明确“继续生成并可查询”还是“取消并退款”，避免 499 后用户不知道结果。
4. 建立 ChatGPT2API 与 image2api 的契约测试，覆盖模型列表、三种生图入口、URL/base64、SSE、401/402/429/5xx 和退款。

### P1：运维和体验

1. 控制台增加节点协议能力版本，升级前自动检查兼容路由。
2. API 日志记录请求协议（images/chat/responses）和响应格式，便于定位特定客户端。
3. 增加对象存储生命周期、容量告警和失败上传重试。
4. 将 Provisioner、集群控制台、image2api 的部署版本统一展示并支持滚动回滚。

## 不应直接迁移的内容

- 不把 ChatGPT2API 的 SQLite、本地图片目录或旧容器依赖带回 image2api。
- 不在媒体核心中实现通用文本聊天、搜索、本地工具执行、PPT/PSD；需要时通过独立服务和明确路由接入。
- 不为了兼容远程 `image_url` 直接开放服务端任意 URL 下载；必须先实现 DNS 重绑定防护、私网地址阻断、大小/类型限制和重定向复检。
- 不复制整目录覆盖二开代码；所有兼容改动必须独立提交、测试并从 GitHub 构建。
