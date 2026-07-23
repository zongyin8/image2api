# Go2Api 二开部署说明

本文是 `zongyin8/image2api` 的生产维护入口。新会话、服务器更新和上游合并前，先阅读本文。

## 版本定位

- 仓库：`https://github.com/zongyin8/image2api`
- 生产分支：`go2api-migration`
- 上游：`https://github.com/cyi-cc/image2api`
- 生产域名：`https://tu.go2api.cc`
- 本版本是 image2api 二开，不是旧 ChatGPT2API 的部署包装。

以下约束必须保持：

1. 不运行或依赖旧 `chatgpt2api` 容器。
2. `/images/` 只转发 image2api，不能再读取 `/opt/gpt/data/images`。
3. “开通管理”由本仓库 `provisioner/` 提供，成功账号直接导入 image2api。
4. 根路径经典界面来自本仓库 `classic-web/`，Vue 界面位于 `/new/`。
5. 集群控制台兼容层来自本仓库 `ops/console_shim.py`，密钥只能来自环境文件。

## 组件和端口

| 组件 | 入口 | 生产位置 | 持久化 |
| --- | --- | --- | --- |
| image2api Web/API | `127.0.0.1:2000` | Docker Compose | PostgreSQL、Redis、RustFS |
| Provisioner | `127.0.0.1:18002` | `provisioner/docker-compose.yml` | `/var/lib/image2api-provisioner` |
| Console shim | `127.0.0.1:18099` | `ops/console_shim.py` + systemd | `.shim_token` |
| Classic web | `/` | `/opt/image2api-g2a/web-user` | 静态文件 |
| Vue web | `/new/` | `/opt/image2api-g2a/new` | 静态文件 |
| Generated media | `/images/` | image2api -> RustFS | `image2api_rustfsdata` |

Nginx 参考配置是 `ops/nginx-tu.go2api.cc.conf`。其中 Provisioner key 是占位符，部署时必须替换，并与 `provisioner.env` 一致。

外层 Nginx 必须覆盖 `X-Real-IP` 并追加 `X-Forwarded-For`。内层 web
容器的 `frontend/default.conf.template` 只信任本机和 Docker 私网代理，
再把还原后的公网 IP 传给后端。不要改回无条件使用容器的
`$remote_addr`，否则所有用户都会被统计为 Docker 网关 IP，注册限流会
错误地共用同一个 24 小时计数桶。

## 二开功能

- 保留上游 image2api 的后台、模型、账号、用户、积分、订单、作品、日志和生成能力。
- ChatGPT 多流任务识别和无 async marker 轮询确认，避免误报 `image generation did not start`。
- Go2Api 用户、积分、CDK 和历史数据迁移脚本位于 `migrate/`。
- 双前端：经典界面和 `/new/` Vue 界面。
- 两套用户生成界面都会保存未提交的草稿：提示词/选项写入
  `localStorage`，参考图原文件写入 IndexedDB 的 `ai-user-drafts`
  数据库，刷新页面后自动恢复。经典界面实现位于
  `classic-web/assets/app.portal.js`，Vue 界面实现位于
  `frontend/src/playground.js`、`frontend/src/utils/draftStorage.js` 和
  `frontend/src/views/PlaygroundView.vue`。
- 经典用户界面的生成结果卡片与 Vue `/new/` 保持一致：鼠标悬停时
  右上角显示复制、下载、加入参考图、删除四个操作；触屏设备常显。
  删除操作通过当前用户鉴权的 `/admin/api/my-files` 删除本人作品。
- 三个用户生成前端的图片放大页支持点位编辑：点击图片添加编号和局部
  修改意见，前端按 ChatGPT Image 2.0 网页版格式生成百分比坐标提示词，
  再把当前图片作为唯一参考图提交。协议取证和维护边界见
  `docs/POINT_EDIT_PROTOCOL.md`；不要新增不存在的 `annotations` 后端字段。
- 集群控制台兼容契约 `/api/*`、`/healthz`。
- 开通管理：邮箱来源、Outlook 号池、并发注册、低水位补号、实时日志。
- 注册结果先落入 Provisioner 队列，再幂等调用 `/admin/api/tokens/import-chatgpt-token`；失败每 60 秒重试。
- V1 ChatGPT 图片代理 URL 使用限时 HMAC 签名，第三方客户端无需转发 API Key 即可显示；`response_format=b64_json` 也受支持。
- 账号管理支持单账号独立出口代理和多选批量修改代理、权重、状态；账号代理优先于节点全局 `proxy.url`，留空则回退全局配置。
- “导入账号”可给整批账号预设同一代理；“添加账号”只接收一个账号。两者都会在 pending 账号启动后台校验前原子写入代理和权重，避免账号短暂直连或被提前调度。
- Adobe Seedance 2.0 / Seedance 2.0 Fast 已接入，实测标准版和 Fast 均可不经日本代理直接调用；详细参数见 `docs/ADOBE_SEEDANCE.md`。
- 自定义 OpenAI 兼容上游按现有 model id 接管，无需为 `gpt-image-2` 新建同名模型。该模型 1K 请求优先使用本地 ChatGPT 账号；只有本地无可用账号或所有本地账号的 Redis 单任务并发槽已满时才切 custom。2K/4K 请求直接走 custom。容量判断实现位于 `backend/internal/service/v1.go` 的 `hasAvailableProviderToken` 和 `effectiveImageProvider`。

## 服务器文件

以下文件属于运行配置，不得提交 Git：

- `/opt/image2api-g2a/provisioner.env`
- `/opt/image2api-g2a/console-shim.env`
- `/opt/image2api-g2a/.shim_token`
- 数据库、RustFS 和 `/var/lib/image2api-provisioner`

仓库提供 `provisioner.env.example` 和 `ops/console-shim.env.example`。生产文件权限应为 `0600`。

## 生产切换基线

`2026-07-16` 已完成以下切换：

- 旧 ChatGPT2API 和 autoheal 容器已删除，旧 Docker 镜像标签已清理。
- 旧图片、视频和缩略图目录已删除；Nginx `/images/` 仅代理 image2api/RustFS。
- 经典门户的视频模式读取 `/admin/api/managed-models` 中已启用的视频模型，
  通过 `/admin/api/generate` 生成；同步连接超时后使用 `/admin/api/jobs/mine`
  自动恢复后台任务，不再依赖旧 ChatGPT2API 的 `/api/video/*` 路由。
- Provisioner 使用本仓库 Compose 运行，旧账号同步器和 watcher 已移除。
- 重复的 `image2api-g2a` 孤立容器已删除，卷暂时保留用于回滚。
- `/opt/gpt` 已完整删除；删除前的关键控制配置和文件清单保存在 cutover 备份目录。

生产源码检出位于 `/opt/image2api-src`，运行配置和静态部署位于 `/opt/image2api-g2a`。

## 当前生产版本（2026-07-23）

Go2Api 主机当前确认的部署基线：

| 组件 | 镜像/版本 | 状态 |
| --- | --- | --- |
| Backend | `i2a-g2a-backend:e966d22` | 本地池忙时自动切 custom，已验证 |
| Web | `i2a-g2a-web:f6e0b0f` | 已有模型 id 可直接由 custom 上游接管 |
| Backend 回滚点 | `i2a-g2a-backend:5e2aa1c` | 保留，不得清理 |

生产 Compose 的权威文件是 `/opt/image2api-g2a/docker-compose.yml`，project 名是
`image2api`，后端容器名是 `image2api-backend-1`。源码目录中的 Compose 不能
覆盖运行目录中的生产配置。

本次后端切换使用：

```bash
cd /opt/image2api-g2a
docker compose -p image2api up -d --pull never --force-recreate backend
docker inspect image2api-backend-1 \
  --format '{{.Config.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Created}}'
```

`e966d22` 已做受控验证：临时占满本地 ChatGPT 账号并发槽后，1K
`gpt-image-2` 请求返回 HTTP 200，结果 URL 来自 `tu.2s21.cc`，事件日志的
实际账号显示“我的备用2s21”。日志的 `provider` 字段仍可能显示模型原生的
`chatgpt`，判断真实落点应看 `account_id/account_email`。

构建 `e966d22` 时根分区一度接近满盘并引发短时 `rate limiter unavailable`。
部署前必须先执行 `df -h /` 和 `docker system df`；只清理明确无用的构建缓存
和 dangling 镜像，不得删除 PostgreSQL/RustFS 卷，也不得删除上述 backend
回滚镜像。后端更新后还要验证登录接口不返回 rate limiter 错误。

## 首次部署

```bash
git clone https://github.com/zongyin8/image2api.git /opt/image2api-src
cd /opt/image2api-src
git checkout go2api-migration

# 主栈按实际生产 .env/Compose 配置启动。
docker compose up -d --build

# 独立开通管理服务。密钥保存在运行目录，源码目录只放符号链接。
install -d -m 700 /opt/image2api-g2a
install -m 600 provisioner.env.example /opt/image2api-g2a/provisioner.env
# 编辑 /opt/image2api-g2a/provisioner.env 后：
ln -sfn /opt/image2api-g2a/provisioner.env /opt/image2api-src/provisioner.env
docker compose -f provisioner/docker-compose.yml up -d --build

# 经典前端与 Vue 静态前端。
rsync -a --delete classic-web/ /opt/image2api-g2a/web-user/
cd frontend && npm ci && npm run build -- --base=/new/
rsync -a --delete dist/ /opt/image2api-g2a/new/

> 注意：`frontend/Dockerfile` 的镜像用于根路径 `/`（默认 base 为 `/`），不能把镜像内的 `/usr/share/nginx/html` 直接复制到 `/new/`。`/new/` 必须单独使用 `--base=/new/` 构建，否则浏览器会请求根路径 `/assets/` 并显示空白页。

# 控制台 shim。
cp ops/console_shim.py /opt/image2api-g2a/console_shim.py
cp ops/console-shim.service /etc/systemd/system/console-shim.service
cp ops/console-shim.env.example /opt/image2api-g2a/console-shim.env
# 编辑 console-shim.env 后：
chmod 600 /opt/image2api-g2a/console-shim.env
systemctl daemon-reload
systemctl enable --now console-shim.service
```

生产主栈可以继续使用预构建镜像，但镜像必须用 Git commit 标记，不能只保留 `latest`。例如：

```bash
git_sha=$(git rev-parse --short HEAD)
docker build -t i2a-g2a-backend:$git_sha -t i2a-g2a-backend:latest backend
docker build -t i2a-g2a-web:$git_sha -t i2a-g2a-web:latest frontend
```

## 从 GitHub 更新

1. 备份 PostgreSQL、RustFS、`/var/lib/image2api-provisioner`、Nginx 和两个环境文件。
2. 在本地 `go2api-migration` 分支合并上游，解决冲突时保留本文列出的二开功能。
3. 跑 Go 测试、前端构建和 Provisioner 冒烟测试。
4. 推送到 `zongyin8/image2api`，记录 commit。
5. 服务器 `git fetch` 后检出明确 commit，不直接跟随不确定的 `latest`。
6. 重建主栈和 Provisioner，部署 `classic-web/`、`frontend/dist/`、`ops/console_shim.py`。
7. 按下方清单验证，再清理旧镜像和备份。

不要用上游目录整体覆盖生产目录；这会丢失 Provisioner、经典界面和控制台兼容层。

## 验证清单

```bash
curl -fsS http://127.0.0.1:2000/health
curl -fsS http://127.0.0.1:18002/healthz
curl -fsS http://127.0.0.1:18099/healthz
nginx -t
```

后端滚动更新还要确认运行镜像、登录限流和最近真实路由：

```bash
docker inspect image2api-backend-1 \
  --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Created}}|{{.RestartCount}}'

# 使用不存在的账号测试时应返回 401“账号或密码错误”，不能返回
# rate limiter unavailable。
curl -sS -o /tmp/login-check.json -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"email":"healthcheck@example.com","password":"invalid-health-check"}' \
  https://tu.go2api.cc/admin/api/auth/login

# 数据库 event_logs 中检查 account_email；provider 不是 custom 落点的唯一依据。
```

注册限流异常时检查 Redis 键：

```bash
docker exec image2api-redis-1 redis-cli --scan --pattern 'rl:auth:register:success:*'
```

键尾应为用户公网 IP，不应是 `172.16.0.0/12` 内的 Docker 网关地址。

还需要人工验证：

- `/` 和 `/new/` 都能登录、生成并查看图片。
- 管理后台账号数量、用户、积分、订单和日志正常。
- “开通管理”能读取配置、邮箱池统计和 image2api 当前可用账号数。
- `/images/` 返回 RustFS 中的新图片，不访问 `/opt/gpt`。
- 旧移动客户端使用的 `POST /v1/chat/completions` 生图兼容入口可用，流式请求每 10 秒发送保活。
- Console shim 的账号、日志、图片和主机指标正常。
- 最近日志没有 `no async marker` 误失败回归。

## 4K 自定义上游

- `gpt-image-2` 的 2K/4K 请求由 custom 账号转发到主力机。
- `gpt-image-2` 的 1K 请求优先本地 ChatGPT 池；本地账号全部忙或不可用时由 custom 兜底。不要把判断退化为“数据库存在 active 账号”，必须保留 Redis 并发容量检查。
- 生产 `base_url` 是 `https://img-main.2s21.cc:18443`，该域名必须保持 Cloudflare DNS only。
- 主力机 18443 端口使用 `img-main.2s21.cc` 证书，并直连本机生图应用；Nginx 读写超时均为 600 秒。
- 不要改回经过 Cloudflare 代理的 `https://tu.2s21.cc`，否则长耗时 4K 请求会出现 520/524。
- 修改后从 go2api 节点验证：`curl -fsS https://img-main.2s21.cc:18443/healthz`。

## 集群控制台接入

- 生产后端必须通过服务器环境变量设置 `CLUSTER_ADMIN_TOKEN`，真实令牌不得提交到仓库。
- 集群控制台节点配置必须设置 `platform: image2api`，并将同一个令牌放在该节点的 `admin_key`。
- 机器接口仅开放 `/admin/api/cluster/users`、用户积分调整和 `/admin/api/cluster/orders`，不复用浏览器管理员会话。
- 修改令牌后必须同时重建 image2api 后端和集群控制台容器，否则用户管理会返回 401。

## 回滚

- 主栈：回退到上一个 commit 标记的 backend/web 镜像。
- Provisioner：检出上一个 commit 后重新构建；数据卷保持不变。
- 静态前端：恢复 `/opt/image2api-g2a/new` 和 `web-user` 的部署前快照。
- Nginx/shim：恢复部署前备份并执行 `nginx -t && systemctl reload nginx`。

回滚不得重新启用旧 ChatGPT2API 容器。注册故障应回滚 Provisioner，自媒体故障应回滚 image2api/RustFS。
