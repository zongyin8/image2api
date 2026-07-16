# CreditLog（积分入账流水）—— 迁移与实现说明

面向数据迁移作者：把 go2api 的 `credit_history`（`admin_recharge` / `redeem` /
`register_gift` / `admin_adjust`）迁入 image2api 新增的 `credit_logs` 表。

本功能只记「入账」（积分增加），不记出图扣费（扣费在生成日志 event_log 里）。

---

## 1. 表结构（确切列名 / 类型）

Go model：`image2api/backend/internal/model/models.go` → `type CreditLog struct`
GORM 建表名（snake_case 复数）：**`credit_logs`**

| 列名 | Go 类型 / gorm tag | PostgreSQL 类型 | 约束 |
|------|--------------------|-----------------|------|
| `id`            | string `primaryKey;size:32`        | `varchar(32)`   | 主键 |
| `user_id`       | string `size:32;index;not null`    | `varchar(32)`   | NOT NULL, 索引 |
| `type`          | string `size:32;index;not null`    | `varchar(32)`   | NOT NULL, 索引 |
| `amount`        | float64 `not null`                 | 见下注①         | NOT NULL，正数=入账 |
| `balance_after` | float64 `not null;default:0`       | 见下注①         | NOT NULL default 0，到账后余额 |
| `title`         | string `size:255`                  | `varchar(255)`  | 说明文案 |
| `created_at`    | time.Time `index`                  | `timestamptz`   | 索引；倒序即时间线 |

注①：`amount` / `balance_after` 是 Go `float64`，GORM Postgres 驱动生成的类型与
**现有 `users.credits`、`orders.amount` 完全一致**（同为 float64 列）。迁移前请先
`\d credit_logs` 确认实际类型再拼 SQL（一般是 `numeric`/`decimal`；整数积分直接写数值即可）。

> 表由 AutoMigrate 自动创建（已在 `model.AutoMigrateModels()` 注册 `&CreditLog{}`，
> `bootstrap/app.go` 里 `db.AutoMigrate(model.AutoMigrateModels()...)` 生效）。
> **迁移脚本无需自己建表**，只需在服务启动过一次后往 `credit_logs` INSERT。

### `id` 生成规则
运行时代码用 `"cl-" + uuid.NewString()[:12]`（例：`cl-1a2b3c4d-5e6`，长度 ≤ 32）。
迁移脚本可自选唯一前缀，建议 `cl-mig-<原始行号或原ID>`，只要全表唯一且 ≤ 32 字符即可，
不必与运行时格式一致。

---

## 2. `type` 取值 & go2api → image2api 映射

运行时代码使用的枚举（`service/credit_log.go` 常量）：

| type       | 含义             | 运行时写入点 |
|------------|------------------|--------------|
| `recharge` | 后台充值         | **仅保留给迁移用**（image2api 运行时不产出，见下） |
| `redeem`   | 兑换码           | 兑换码到账 |
| `gift`     | 赠送（签到等）   | 每日签到 |
| `admin`    | 管理员调整       | 管理员加积分（delta>0） |
| `order`    | 易支付充值到账   | 易支付订单 paid |

**建议映射（go2api `credit_history.type` → image2api `type`）：**

| go2api            | image2api `type` |
|-------------------|------------------|
| `admin_recharge`  | `recharge`       |
| `redeem`          | `redeem`         |
| `register_gift`   | `gift`           |
| `admin_adjust`    | `admin`          |

- `title` 列：把 go2api 的说明/detail 文案原样搬过来即可（前端直接展示 `title`）。
  若源库没有说明，可按类型给个默认中文（后台充值 / 兑换码 / 注册赠送 / 管理员调整）。
- `balance_after`：go2api 若有「变动后余额」列，直接搬；没有就填当时余额或 0（前端容忍 0/缺省）。
- `amount`：填**正数**入账金额。go2api 里若有负数（扣减）记录，**不要迁**（本表只记入账）。
- `user_id`：必须对应 image2api `users.id`。用户迁移脚本 `migrate_go2api_users.py` 决定了
  新 `users.id`，请与其保持一致的映射（同一把老 key/username → 同一个新 user id）。
- `created_at`：搬原始时间戳；缺失可用 `NOW()`。

前端类型中文化对照（两个前端都已按此展示）：
`recharge=后台充值, redeem=兑换码, gift=赠送, admin=管理员调整, order=支付到账`。

---

## 3. 记账 helper 签名

`image2api/backend/internal/service/credit_log.go`

```go
type CreditLogService struct { /* holds *repo.CreditLogRepository */ }

func NewCreditLogService(logs *repo.CreditLogRepository) *CreditLogService

// 追加一条入账记录。best-effort：出错只打日志，绝不回滚/阻断真实加分。
// amount 必须 > 0，否则直接跳过（不记）。
func (s *CreditLogService) LogCredit(
    ctx context.Context,
    userID, typ string,
    amount, balanceAfter float64,
    title string,
)

// 分页查询本人入账记录（created_at 倒序）
func (s *CreditLogService) ListByUser(
    ctx context.Context, userID string, page, pageSize int,
) ([]model.CreditLog, int64, error)
```

repo 层：`repo.CreditLogRepository`（`repo/credit_log_repo.go`）—— `Create` + `ListByUser(limit, offset)`。

---

## 4. 只读端点

`GET /admin/api/credit-logs?page=&page_size=`（在 router.go 的 `userAuthed` 组，
session/token 鉴权，只返回**调用者本人**的记录）。

响应：
```json
{
  "data": [
    {"type":"redeem","amount":100,"balance_after":350,"title":"兑换码 ABCD-...","created_at":1720000000}
  ],
  "total": 42,
  "page": 1,
  "page_size": 20
}
```
- `created_at` 为 **Unix 秒**（整数）。
- 倒序（最新在前）。`page` 从 1 起；`page_size` 默认 20，上限 100。

---

## 5. 新增 / 改动文件清单

新增：
- `backend/internal/model/models.go` —— 新增 `CreditLog` struct + 注册进 `AutoMigrateModels()`
- `backend/internal/repo/credit_log_repo.go` —— 新增仓储（Create / ListByUser）
- `backend/internal/service/credit_log.go` —— 新增 `CreditLogService`（LogCredit / ListByUser + type 常量）
- `backend/internal/http/handler/credit_log.go` —— 新增只读 handler
- `migrate/CREDIT_LOG_NOTES.md` —— 本文件

改动（接线 + 记账点）：
- `backend/internal/bootstrap/app.go` —— 构造 creditLogRepo/Svc，注入 4 个服务，注册 handler
- `backend/internal/http/router/router.go` —— Handlers 加 `CreditLog`，注册 `GET /credit-logs`
- `backend/internal/service/cdk.go` —— 兑换成功后记 `redeem`
- `backend/internal/service/admin_write.go` —— `AdjustUserCredits` 且 delta>0 记 `admin`
- `backend/internal/service/payment.go` —— 易支付订单 paid 记 `order`
- `backend/internal/service/auth.go` —— 每日签到入账记 `gift`

前端（展示，不影响迁移）：
- `image2api/frontend/src/views/OrdersView.vue` —— 新增「入账记录」标签页
- `web-user/assets/app.image2api.js` —— 充值页「充值记录」接入 `/credit-logs`（原为占位）

---

## 6. ⚠️ 需要拍板 / 未硬猜的点

1. **image2api 注册当前不送积分**：`auth.go` 的 `Register` / `RegisterUsername` 建号时
   `credits` 默认 0，没有「注册赠送」逻辑，故运行时**不会产生 `gift`(注册) 记录**。
   go2api 的 `register_gift` 历史数据照迁即可（映射到 `gift`），但新注册用户不会有新
   注册赠送流水——除非你之后给 image2api 加「注册送积分」设置。已把 `gift` 用于「每日签到」。

2. **邀请奖励未接记账**：`v1.go` 的 `maybeGrantInviteReward` → `users.GrantInviteReward`
   把积分发给**邀请人**（不是当前操作用户），且发生在 repo 事务内、只返回 bool，拿不到
   邀请人余额。要记这笔 `gift` 需要改 `GrantInviteReward` 返回 (inviterID, 新余额)。
   **本次未改**（避免动核心事务签名）。如需要邀请奖励也进流水，请单独确认后再加。

3. **`recharge` vs `admin`**：image2api 后台只有一个「调整积分」入口（`AdjustUserCredits`，
   delta>0 记 `admin`），没有独立的「后台充值」通道。故运行时不产出 `recharge`；
   `recharge` 这个 type 专门留给 go2api `admin_recharge` 历史数据。若你希望后台加分统一显示
   为「后台充值」，可把映射改成 `admin_recharge→admin` 并弃用 `recharge`——按你迁移口径定。

4. **金额精度**：积分在 go2api 多为整数，image2api 存 float64。迁移时按数值原样写入即可，
   前端直接展示数字。
