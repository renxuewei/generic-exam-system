# 通用题库系统 (Generic Exam System)

多学科题库和考试系统，支持用户注册登录、AI 智能生成试题、错题管理、学习进度追踪、管理后台、数据备份恢复等功能。

## 主要特性

- **多学科管理**: 创建和管理多个学科的题库
- **用户系统**: 邮箱注册、激活、登录、忘记密码
- **AI 智能生成**: 基于 OpenAI 兼容 API 自动生成模拟题
- **完整考试系统**: 在线做题、自动评卷、答题记录
- **错题管理**: 自动收集错题，连续答对 3 次自动移除
- **学习分析**: 进步指数、弱点域分析、做题历史、错题率统计
- **管理后台**: 查看用户列表、禁用/启用用户、查看用户学科数据
- **数据备份/恢复**: 下载全部业务数据（ZIP），上传合并恢复
- **数据导入**: 支持 JSON 格式题目批量导入

## 快速开始

### 前置要求

- Node.js (v18 或更高版本)
- npm

### 安装依赖

```bash
npm install
```

### 环境配置

创建 `.env` 文件（参考 `.env.example`）：

```env
# AI（可选，用于 AI 生成题目）
AI_API_KEY=sk-<your-api-key>
AI_BASE_URL=https://api.deepseek.ai/v1
AI_MODEL=deepseek-reasoner

# Session
SESSION_SECRET=your-random-secret-here

# 邮件（Resend，用于注册激活和密码重置）
RESEND_API_KEY=re_xxxxx
EMAIL_FROM=noreply@yourdomain.com
BASE_URL=https://your-app.vercel.app

# 管理后台
ADMIN_TOKEN=your-secure-admin-token
```

> 不配置 `RESEND_API_KEY` 时，激活链接和重置链接会输出到控制台。

### 启动

```bash
npm start
```

应用将在 `http://localhost:8000` 启动。本地开发使用文件型 SQLite（`quiz.db`），无需额外配置数据库。

## 项目结构

```
generic-exam-sys/
├── server.js          # Express 服务器
├── db.js              # 数据库操作（@libsql/client）
├── email.js           # 邮件发送（Resend）
├── ai-gen.js          # AI 试题生成
├── prompt.txt         # AI 系统提示词
├── package.json
├── vercel.json        # Vercel 部署配置
├── .env.example       # 环境变量模板
│
├── public/
│   └── index.html     # 单页应用（前端）
│
└── inputs/            # 题目数据输入
    ├── *.js           # JS 格式题目文件
    ├── *.json         # JSON 格式题目文件
    └── errors-*.txt   # 错题日志
```

## API 概览

### 认证

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册（发送激活邮件） |
| POST | `/api/auth/activate` | 激活账户 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 获取当前用户 |
| POST | `/api/auth/forgot-password` | 发送密码重置邮件 |
| POST | `/api/auth/reset-password` | 重置密码 |

### 学科管理（需登录）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/subjects` | 学科列表 |
| GET | `/api/subject/:id` | 学科详情 |
| POST | `/api/subjects` | 创建学科 |
| PUT | `/api/subjects/:id` | 更新学科 |
| DELETE | `/api/subjects/:id` | 删除学科 |

### 考试与错题（需登录）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/quiz/:subjectId` | 获取题目（`?random=N` 随机抽题） |
| GET | `/api/sources/:subjectId` | 获取题集来源 |
| POST | `/api/submit` | 提交考试结果 |
| GET | `/api/review` | 获取错题（`?subjectId=&count=`） |
| POST | `/api/review/submit` | 提交错题复习结果 |
| GET | `/api/progress/:subjectId` | 学习进度 |
| GET | `/api/weakness/:subjectId` | 弱点域分析 |
| POST | `/api/aigen` | AI 生成题目 |

### 备份恢复（需登录）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/backup/export` | 下载 ZIP 备份 |
| POST | `/api/backup/restore` | 上传 ZIP 恢复 |

### 管理后台

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/admin/users` | 用户列表 |
| PUT | `/api/admin/users/:id/toggle` | 禁用/启用用户 |
| GET | `/api/admin/users/:id/subjects` | 用户学科详情 |

> 管理接口通过 `X-Admin-Token` 请求头传递 `ADMIN_TOKEN` 进行认证。

## 数据库

本地开发使用文件型 SQLite（通过 `@libsql/client`），Vercel 部署使用 Turso 云数据库。

主要数据表：`users`、`subjects`、`questions`、`wrong_questions`、`exam_history`、`sessions`

## 支持的题型

- `single` — 单选题
- `multiple` — 多选题
- `true-false` — 判断题
- `fill-blank` — 填空题
- `short-answer` — 简答题
