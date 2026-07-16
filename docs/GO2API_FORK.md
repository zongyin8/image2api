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

## 二开功能

- 保留上游 image2api 的后台、模型、账号、用户、积分、订单、作品、日志和生成能力。
- ChatGPT 多流任务识别和无 async marker 轮询确认，避免误报 `image generation did not start`。
- Go2Api 用户、积分、CDK 和历史数据迁移脚本位于 `migrate/`。
- 双前端：经典界面和 `/new/` Vue 界面。
- 集群控制台兼容契约 `/api/*`、`/healthz`。
- 开通管理：邮箱来源、Outlook 号池、并发注册、低水位补号、实时日志。
- 注册结果先落入 Provisioner 队列，再幂等调用 `/admin/api/tokens/import-chatgpt-token`；失败每 60 秒重试。

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
- Provisioner 使用本仓库 Compose 运行，旧账号同步器和 watcher 已移除。
- 重复的 `image2api-g2a` 孤立容器已删除，卷暂时保留用于回滚。
- `/opt/gpt` 已完整删除；删除前的关键控制配置和文件清单保存在 cutover 备份目录。

生产源码检出位于 `/opt/image2api-src`，运行配置和静态部署位于 `/opt/image2api-g2a`。

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
cd frontend && npm ci && npm run build
rsync -a --delete dist/ /opt/image2api-g2a/new/

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

还需要人工验证：

- `/` 和 `/new/` 都能登录、生成并查看图片。
- 管理后台账号数量、用户、积分、订单和日志正常。
- “开通管理”能读取配置、邮箱池统计和 image2api 当前可用账号数。
- `/images/` 返回 RustFS 中的新图片，不访问 `/opt/gpt`。
- Console shim 的账号、日志、图片和主机指标正常。
- 最近日志没有 `no async marker` 误失败回归。

## 回滚

- 主栈：回退到上一个 commit 标记的 backend/web 镜像。
- Provisioner：检出上一个 commit 后重新构建；数据卷保持不变。
- 静态前端：恢复 `/opt/image2api-g2a/new` 和 `web-user` 的部署前快照。
- Nginx/shim：恢复部署前备份并执行 `nginx -t && systemctl reload nginx`。

回滚不得重新启用旧 ChatGPT2API 容器。注册故障应回滚 Provisioner，自媒体故障应回滚 image2api/RustFS。
