# HDU 图书馆座位自动抢座

基于 NestJS 的杭电图书馆座位自动预约系统，通过 CAS 统一认证登录，支持多账号批量管理，在放号时间点自动抢座。前端经 **Caddy 反向代理** 对外提供服务，自带 Basic Auth 鉴权，避免 HTTP 明文暴露。微信端通过 **WxPusher** Topic 广播推送抢座关键节点通知。

## 已实现功能

- **多账号管理**：前端添加/删除/强制重登账号，添加时即时 CAS 验证（密码错误不入库）；密码 AES-256-GCM 加密入库，密钥来自环境变量；按 4 账号并发抢座设计（`concurrency=8`，未做账号数硬上限校验）
- **CAS 统一认证登录**：通过学校 SSO 自动登录（AES-128-ECB 加密密码），每个账号各自维持独立登录态（会话注册表 + 每账号独立登录锁），心跳每账号 5 分钟错峰检测保活；账号状态徽标细分为「正常 / 登录失败 / 登录已失效」
- **RoomID 自习室分类体系**：明确了 `category_id`（业务分类，如自习室=591）→ `content_id`（业务子类型=3）→ `roomId`（具体房间 info.id，如二楼东=1557）→ `seatId`（座位 POIs[].id）的四级结构；所有自习室共用同一对 category/content，房间由 roomId 区分
- **抢座任务管理**：REST API 创建、查询、终止抢座任务；同账号新任务覆盖旧 pending 任务；同账号已有 running 任务时拒绝创建；跨账号座位偏好重合给出软警告；任务锁定 roomId/roomName 后偏好座位号才能唯一解析为 seatId
- **批量多账号提交**：前端可勾选多个账号同时创建任务，每账号独立设置座位偏好，支持「默认偏好 → 一键应用到全部」批量填充
- **定时抢座调度**：BullMQ 延迟队列，在指定时间点精准触发；触发时刻已过则自动顺延到次日；**放号前 5 分钟自动执行 session-precheck，无条件刷新该账号登录态**（失败推送 `session_precheck_failed` 通知，不取消主任务）；严格模式下同时执行 **seat-preparse 座位预解析**（把偏好座位号 → seatId，供盲抢使用）
- **座位预解析（preparse）**：触发前 5 分钟执行，根据房间配置和座位号解析出 seatId；未指定房间时多房间同名座位自动锁定一间；解析失败写入 `result.preparse`，触发时自动重试，仍失败则回退普通模式准点开抢
- **自动抢座执行**：searchSeats 获取座位 → 按优先级选座（偏好 > 推荐 > 任意）→ bookSeats 提交预约；支持 **strictMode 严格模式**（只抢偏好座位，不降级）；严格模式下启用 **盲抢（book-first）** —— 跳过 searchSeats 直接用预解析的 seatId 提交预约，放号窗口未打开时以 300ms 间隔快速探测（10 次连续命中后退避），并加入随机抖动避免多账号同步触限流；盲抢带 5s 偏移（blindStartOffsetMs）等待放号窗口实际打开
- **两段式重试**：时间窗口驱动（3 分钟窗口，以 triggerAt 为绝对锚点）——唤醒后前 15 秒高频探测（1 秒/轮），之后低频（3 秒/轮）；座位被占自动换座重试并实时提醒；限流错误单独退避 3 秒；未知错误累计 2 次后退化为低频继续重试（直到窗口耗尽）；黑名单/参数错误等不可恢复错误立即终止
- **实时提醒**：偏好座位被占时发 `seat_taken` 通知并写入任务结果（`result.takenSeats`），前端轮询实时可见
- **任务终止**：pending 阶段从队列移除、running 阶段协作式退出，均标记 `cancelled`；前端支持一键终止所有活跃任务
- **WxPusher 微信推送**：7 类事件（pre_reminder / grab_started / seat_taken / grab_success / grab_failed / session_precheck_failed / preparse_warning），其中 5 类核心事件推送到微信（Markdown 模板），通过 Topic 广播模式分发；推送失败只打 warn 日志，绝不影响抢座主流程
- **前端页面**：单页表单批量提交抢座任务 + 实时轮询任务状态 + 账号管理区块（状态徽标、30 秒轮询刷新）；**刷新页面后自动恢复所有活跃任务**（pending/running），不会丢失已提交的任务

## 未实现 / 待完成

- **应用内鉴权系统**：账号与任务通过前端统一管理，无多用户注册/登录/细粒度权限控制；入口级鉴权由 Caddy Basic Auth 提供（单用户名 + 密码）
- **账号数硬上限**：计划目标为最多 4 个账号，代码未实现数量校验（并发余量已按 4 账号设计）
- **更多自习室支持**：目前前端仅配置并实测了「二楼东」自习室，二楼西 / 四楼等 roomId 已抓包确认但暂未启用（在 `frontend/src/config/rooms.ts` 中注释占位）
- **微信小程序原生推送**：当前通过 WxPusher 服务号中转实现微信通知，原生小程序订阅消息推送待后续接入

## 技术栈

- **后端**：NestJS + TypeORM + MySQL + Redis (BullMQ)
- **前端**：React + Vite + TypeScript
- **网关 / 安全层**：Caddy（HTTPS + Basic Auth + 反代到前端 nginx）
- **基础设施**：全部容器化（Docker Compose：MySQL + Redis + 后端 + 前端 nginx + Caddy）

## 前置要求

**方式一（推荐）：Docker 一键启动**

- 仅需安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，无需本地安装 Node.js / MySQL / Redis

**方式二：本地开发模式**

- Node.js 18+ + Docker Desktop（MySQL/Redis 容器仍由 Compose 提供）

## 环境配置

推荐直接运行初始化脚本生成 `.env`（自动填入随机 `ACCOUNT_SECRET_KEY` 与 `DB_PASSWORD`，并复制 `auth.caddy` 模板），再按需修改：

```bash
sh scripts/init-env.sh        # macOS / Linux / Windows Git Bash
```

> Windows 用户：推荐使用 Git Bash 执行上述脚本（Docker Desktop 安装时通常会一并安装 Git Bash）。如果用 PowerShell，可手动复制 `.env.example` 为 `.env`、复制 `auth.caddy.example` 为 `auth.caddy`，然后按下方说明手动填入密钥。

也可以手动复制 `.env.example` 为 `.env` 并修改，完整字段如下：

```bash
# 应用
PORT=3000
NODE_ENV=development

# 对外端口（由 Caddy 容器发布，Basic Auth 鉴权后转发 frontend）
# 共享服务器上 8080 等常用端口可能被占用，部署前先确认端口空闲
FRONTEND_PORT=18080

# MySQL（以下为本地开发模式默认值；容器化部署时 DB_HOST/DB_PORT/DB_USERNAME 由 compose 覆盖）
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=<建议 init-env 脚本生成或自设，容器部署时与 MySQL 容器共用>
DB_DATABASE=library_seat

# Redis（同上，容器化部署时 REDIS_HOST/REDIS_PORT 由 compose 覆盖）
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# BullMQ
BULLMQ_PREFIX=library-seat

# 通知模式：mock | wxpusher
# mock：打日志 + 写 notifications 表；wxpusher：WxPusher Topic 广播推送到微信
NOTIFY_MODE=mock

# WxPusher 微信推送（NOTIFY_MODE=wxpusher 时生效）
# appToken / topicId 在 WxPusher 后台获取，Topic 创建与订阅二维码为后台一次性操作
WXPUSHER_APP_TOKEN=
WXPUSHER_TOPIC_ID=

# 图书馆 API 基地址
LIBRARY_API_BASE_URL=https://hdu.huitu.zhishulib.com

# 账号密码加密密钥（必填，AES-256-GCM 32 字节）
# 未配置或格式错误时应用启动直接终止（fail-fast）
# 生成方式: 运行 init-env 脚本自动生成，或 node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ACCOUNT_SECRET_KEY=<64位hex或base64>

# CAS 统一认证登录凭据（可选，仅当 accounts 表为空时自动种子一条账号，属迁移兼容项）
CAS_USERNAME=你的学号
CAS_PASSWORD=你的密码
CAS_SERVICE=https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin?forward=%2FSpace%2FCategory%2Flist%3Fcategory_id%3D591
```

> Caddy Basic Auth 凭据**不放在 `.env` 中**：bcrypt 哈希中的 `$` 会被 Docker Compose 的变量插值截断，导致鉴权静默失效。凭据改为写在 `auth.caddy` 文件中（模板见 `auth.caddy.example`，init-env 脚本会自动复制一份），由 `Caddyfile` 原样 import，全程不经插值。

> 账号现在通过前端「账号管理」区块添加（即时 CAS 验证后加密入库）。`CAS_USERNAME/CAS_PASSWORD` 只在首次启动且 accounts 表为空时起种子作用。

## 系统流程

### RoomID 自习室分类结构

图书馆 API 的四级标识体系：

```
category_id（591）          业务分类：自习室预约
  └─ content_id（3）        业务子类型
       └─ roomId（1557）    具体房间 info.id，如「二楼东」
            └─ seatId       单个座位 POIs[].id，如「400号座位」
```

所有自习室（二楼东/二楼西/四楼…）共用同一对 `category_id` / `content_id`，房间由 `roomId` 区分。任务锁定 `roomId` 后，偏好座位号才能唯一解析为 `seatId`（盲抢的前提）。

### 端到端流程

```
Caddy（Basic Auth 鉴权）
   │  反代
   ▼
前端「账号管理」添加账号（即时 CAS 验证，成功后加密入库）
       │
用户批量勾选账号 + 填写预约设置（房间/日期/时段/偏好/触发时间/严格模式）
       │  前端逐账号创建任务，触发时间已过则自动顺延次日
       ▼
  POST /grab-tasks 创建任务（状态: pending）
  ├─ 同账号已有 pending → 旧任务标记 failed（被新任务覆盖）
  ├─ 同账号已有 running → 拒绝创建
  └─ 跨账号同触发日任务偏好座位重合 → 响应带 warnings 提示
       │
       ▼
  TaskScheduler 计算延迟，推入 BullMQ 延迟队列（每个任务两个 job）
       │
       ├─（triggerAt 前 5 分钟）precheck job
       │    ├─ session-precheck：无条件 refreshSession(该账号)，失败推 session_precheck_failed 通知
       │    └─ seat-preparse（严格模式 + 有偏好）：座位号 → seatId 预解析
       │         ├─ 已指定 roomId → 直接解析
       │         ├─ 未指定 roomId → 多房间同名座位自动锁定一间
       │         └─ 解析失败 → 写入 result.preparse，触发时重试，仍失败回退普通模式
       │
       ▼（到达 triggerAt 时间点）
  grab-seat job 唤醒 → GrabSeatProcessor → GrabSeatWorker.executeGrab()
       │
       ▼
  1. 通知：pre_reminder（提前提醒）+ grab_started（任务开始）
  2. 状态更新为 running
  3. 时间窗口驱动的重试循环（3 分钟窗口，锚定 triggerAt）：
       │  高频段（前 15 秒）：1 秒/轮；低频段：3 秒/轮；限流退避 3 秒
       │  未知错误累计 2 次 → 降级为低频继续（窗口耗尽才终止）
       │
       ├─ [严格模式 + 有偏好 + 预解析成功] 盲抢（book-first）：
       │    跳过 searchSeats，直接用预解析 seatId 调 bookSeats
       │    WINDOW_NOT_OPEN 时 300ms 快速探测（10 次连中后退避）+ 随机抖动
       │    触发 5s 偏移（blindStartOffsetMs），等待放号窗口实际打开
       │
       └─ [普通模式 / 严格模式无偏好 / 预解析失败] 正常流程：
            ├─ searchSeats（获取最新座位快照）
            ├─ 按优先级筛选候选座位（偏好 > 推荐 > 任意；strictMode 只取偏好）
            ├─ 依次尝试 bookSeats
            │    ├─ 成功 → 标记 success + 通知
            │    ├─ 座位被占 → seat_taken 实时提醒 + 换下一个候选座位
            │    ├─ 登录态失效 → 只重登该账号后重试
            │    ├─ 未知错误 → 累计 2 次后降级为低频继续
            │    └─ 黑名单/不可恢复 → 标记 failed + 通知
            └─ 循环期间可随时被用户终止（协作式退出，标记 cancelled）
```

### 通知事件

| 事件类型 | 微信推送 | 说明 |
|----------|----------|------|
| `pre_reminder` | ✓ | 抢座开始前提醒 |
| `grab_started` | ✓ | 抢座任务开始执行 |
| `seat_taken` | ✓ | 偏好座位被占，自动换座重试 |
| `grab_success` | ✓ | 预约成功，附座位号与时段 |
| `grab_failed` | ✓ | 预约失败，附失败原因 |
| `session_precheck_failed` | ✗ | 预检查登录态刷新失败（仅日志 + 数据库） |
| `preparse_warning` | ✗ | 座位预解析异常（仅日志 + 数据库） |

## 快速开始

### 方式一：Docker 一键启动（推荐）

全新电脑 clone 仓库后只需三步（无需本地安装 Node.js / MySQL / Redis）：

```bash
# 1. 一次性初始化：生成 .env（随机 ACCOUNT_SECRET_KEY 与 DB_PASSWORD）+ auth.caddy 模板
sh scripts/init-env.sh

# 2. 设置 Basic Auth 密码（Caddy 入口鉴权，防止应用被公网裸奔）
#    用 caddy 命令生成 bcrypt 哈希（也可在已安装 caddy 的机器上生成）：
docker run --rm caddy:2-alpine caddy hash-password --plaintext "你的密码"
#    将输出的哈希填入 auth.caddy（把 <username> 和 <bcrypt_hash> 替换为实际值）

# 3. 构建并启动全部五个服务（MySQL + Redis + 后端 + 前端 + Caddy）
docker compose up -d --build
```

验证就绪（五个服务全部 `healthy`/`running`）：

```bash
docker compose ps
```

- 访问地址：http://localhost:18080（端口取自 `.env` 的 `FRONTEND_PORT`；Caddy 是唯一对外入口，经 Basic Auth 鉴权后转发到前端，API 再由前端 nginx 同源反代）
- 手机远程访问：手机与电脑连同一 Wi-Fi，访问 `http://<电脑局域网IP>:18080`（Windows 首次需在防火墙放行对应端口）
- 端口占用说明：整套服务只占用宿主机 `FRONTEND_PORT` 一个端口，MySQL/Redis/后端/前端 nginx 均走 Docker 内网——适合部署到与他人共用的服务器；若该端口被占，改 `.env` 里的 `FRONTEND_PORT` 即可
- 首次启动因拉取镜像 + 安装依赖需数分钟；之后重启只需 `docker compose up -d`，通常 30 秒内就绪
- 数据持久化在 `mysql-data` / `redis-data` / `caddy-data` / `caddy-config` 四个 Docker 卷中，`docker compose down` 不会丢数据（`down -v` 才会删除卷，慎用）

> `.env` 由初始化脚本生成后，CAS 凭据等其余配置可随时编辑 `.env` 补充，然后 `docker compose up -d` 重建后端生效。修改 `auth.caddy` 后需 `docker compose restart caddy` 生效。

### 方式二：本地开发模式（热重载）

#### 1. 启动基础设施

MySQL 与 Redis 由容器提供，需叠加开发覆盖文件以发布本机回环端口供直连（基础 compose 不在宿主机绑定 3306/6379，以适配共享服务器部署）：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d mysql redis
```

数据库 `library_seat` 由 MySQL 容器自动创建，表结构在后端首次启动时自动同步（TypeORM synchronize）。

#### 2. 安装依赖

```bash
# 后端依赖
npm install

# 前端依赖
cd frontend
npm install
cd ..
```

#### 3. 启动后端

```bash
# 开发模式（热重载）
npm run start:dev
```

启动过程注意观察控制台输出，**CAS 登录发生在 HTTP 监听之前**：

1. **加密自检**：`ACCOUNT_SECRET_KEY` 未配置或格式错误 → 启动立即终止（fail-fast），按提示配置后重启。
2. **CAS 登录**：逐个串行登录 accounts 表中全部 ACTIVE 账号（间隔约 1 秒错峰），成功打印 `初始化登录成功: <学号>`，失败打印 `初始化登录失败: ...`（单个失败不阻塞启动）。
3. **HTTP 监听**：最后看到 `Nest application successfully started`，后端在 `http://localhost:3000` 就绪，此时可启动前端。

> 如果 CAS 登录失败（网络不通或账号密码错误），后端服务本身仍能正常启动，只是涉及抢座的接口会因缺少登录态而失败。可稍后在前端「账号管理」点「刷新登录」，或排查后重启后端重新触发登录（心跳每 5 分钟也会自动检测并重试）。

#### 4. 启动前端

```bash
cd frontend
npm run dev
```

前端默认运行在 `http://localhost:5173`。

#### 5. 首次使用流程

1. 配置 `.env`（尤其 `ACCOUNT_SECRET_KEY`），启动后端与前端
2. 前端展开「账号管理」→ 输入学号 + 密码 →「添加并验证」（CAS 登录需数秒，失败会显示具体原因）
3. 主表单勾选一个或多个账号，选择自习室、预约日期、时间段，填写座位偏好（每账号独立，也可用「默认偏好 → 应用到全部」批量填充），设置触发时间，按需勾选严格模式
4. 提交后前端逐账号创建任务，每 2 秒轮询任务状态；放号前 5 分钟系统自动刷新登录态并预解析座位，到点自动抢座
5. 进行中可随时点「终止所有任务」一键取消；刷新页面后活跃任务（pending/running）会自动恢复显示
6. 如需微信推送：在 WxPusher 后台创建 Topic，将 `WXPUSHER_APP_TOKEN` 和 `WXPUSHER_TOPIC_ID` 填入 `.env`，并把 `NOTIFY_MODE` 改为 `wxpusher`，重启后端生效

## 项目结构

```
.
├── src/
│   ├── cas/                          # CAS 统一认证登录（AES-128-ECB 加密 + Cookie 管理）
│   ├── common/
│   │   ├── constants/                # API 端点常量 + 自习室全局常量（category_id/content_id/roomId 体系）
│   │   └── utils/                    # 时间工具、form-urlencoded 编码、AES-256-GCM 加密、时间窗口工具
│   ├── config/                       # 环境变量配置映射
│   ├── modules/
│   │   ├── account/                  # 账号管理（Entity/Service/Controller，即时 CAS 验证）
│   │   ├── hdu-library/              # 图书馆 API 客户端（searchSeats/bookSeats，按账号取凭证）
│   │   │   ├── dto/                  # 请求/响应 DTO
│   │   │   └── errors/               # 错误分类与重试判断
│   │   ├── grab-task/                # 抢座任务 CRUD（Entity/Service/Controller，含 roomId 锁定）
│   │   ├── scheduler/                # BullMQ 延迟队列调度（主任务 + session-precheck + seat-preparse）
│   │   ├── queue/                    # BullMQ 队列处理器（GrabSeatProcessor，concurrency=8）
│   │   ├── grab-seat/                # 抢座执行核心（Worker + 选座策略 + 盲抢预解析服务）
│   │   │   ├── strategies/           # 座位选择策略（优先级排序、严格模式过滤）
│   │   │   └── seat-preparse.service.ts  # 座位号 → seatId 预解析（盲抢前置）
│   │   ├── session/                  # 多账号登录态保活（real/mock 双实现 + 心跳错峰 + 自动重登）
│   │   ├── notification/             # 通知服务（接口 + Mock + WxPusher 实现 + 模板 + Entity）
│   │   │   └── notification-templates.ts  # 5 类微信 Markdown 消息模板
│   │   └── grab-attempt-log/         # 抢座尝试日志（含耗时埋点）
│   ├── app.controller.ts             # 根路由（健康检查）
│   ├── app.service.ts
│   └── main.ts                       # 应用入口
├── frontend/
│   ├── Dockerfile                    # 前端镜像（vite build + nginx）
│   ├── nginx.conf                    # 前端 nginx 配置（API 反代）
│   └── src/
│       ├── api/                      # 后端 API 调用（grabTasks + accounts）
│       ├── config/                   # 自习室配置（roomId 列表）
│       ├── hooks/                    # 轮询任务状态 Hook
│       └── utils/                    # 时间工具
├── scripts/                          # 一次性脚本（init-env 初始化、登录验证、API 探测等）
│   └── init-env.sh                   # 生成 .env + auth.caddy 模板（macOS/Linux/Git Bash）
├── Caddyfile                         # Caddy 反代配置（Basic Auth + 转发 frontend）
├── auth.caddy.example                # Basic Auth 凭据模板（init-env 复制为 auth.caddy）
├── Dockerfile                        # 后端镜像（多阶段构建）
├── docker-compose.yml                # MySQL + Redis + 后端 + 前端 + Caddy 五服务编排
├── docker-compose.dev.yml            # 开发模式覆盖（暴露 MySQL/Redis 端口到宿主机）
├── .env                              # 环境变量（init-env 脚本生成，不进 git）
└── README.md
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/accounts` | 添加账号（`{username, password}`，即时 CAS 验证后入库） |
| GET | `/accounts` | 账号列表 + 最近登录态（永不返回密码） |
| POST | `/accounts/:id/refresh` | 强制重新登录 |
| DELETE | `/accounts/:id` | 删除账号（有进行中任务时拒绝） |
| POST | `/grab-tasks` | 创建抢座任务（绑定 accountId） |
| GET | `/grab-tasks?accountId=xxx` | 查询该账号的所有任务 |
| GET | `/grab-tasks/:id` | 查询单个任务状态 |
| DELETE | `/grab-tasks/:id` | 终止任务（pending 移除队列 / running 协作式退出） |

## Docker 常用命令

```bash
docker compose up -d --build     # 构建并启动全部五个服务
docker compose up -d             # 启动（镜像已构建时，秒级完成）
docker compose ps                # 查看状态（healthy 即就绪）
docker compose logs -f backend   # 跟踪后端日志（Ctrl+C 退出）
docker compose logs -f caddy     # 跟踪 Caddy 日志（Basic Auth 失败排查）
docker compose restart backend   # 重启单个服务
docker compose restart caddy     # 修改 auth.caddy 后重启 Caddy 生效
docker compose down              # 停止全部服务（数据卷保留）
```

## 注意事项

- Caddy Basic Auth 是应用的第一道防线，**部署前务必修改 `auth.caddy` 中的占位凭据**。init-env 生成的模板中用户名和 bcrypt 哈希都是占位符，不填入真实值 Caddy 会启动失败（fail-fast，不会无鉴权暴露）
- Caddy 的 bcrypt 哈希必须通过 `auth.caddy` 文件挂载注入，不能写在 `.env` 里——compose 的变量插值会截断 `$` 开头的哈希段，导致鉴权静默失效
- 开发环境下 TypeORM 开启了 `synchronize: true`，会自动同步表结构，**生产环境请关闭**
- `NOTIFY_MODE` 支持 `mock`（默认）与 `wxpusher` 两种模式；切换到 WxPusher 后需同时配置 `WXPUSHER_APP_TOKEN` 和 `WXPUSHER_TOPIC_ID`
- `ACCOUNT_SECRET_KEY` 是账号密码的加密密钥，**切勿泄露或提交到版本控制**；一旦更换，已入库的账号密码将无法解密（需删除后重新添加）
- `.env` 中的凭据配置同样**切勿提交到版本控制**
- 目前前端仅配置并实测了「二楼东」自习室，二楼西 / 四楼等 `roomId` 已抓包确认但暂未启用（在 `frontend/src/config/rooms.ts` 中注释占位，验证无误后去掉注释即可）
- 所有自习室共用同一对 `category_id=591` / `content_id=3`，房间由 `roomId`（`info.id`）区分，详见 [RoomID 自习室分类结构](#roomid-自习室分类结构)
- 错误分类的关键词匹配基于有限样本，实际运行时可能遇到未分类的错误文案落入 `UNKNOWN` 类别（限制重试 2 次后终止）
- 图书馆侧限流按账号还是按 IP 计算属前提假设（`scripts/phase2.5-concurrent-experiment.ts` 为双账号并发验证脚本），多账号并发时注意观察限流错误码
