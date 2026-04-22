# Vercel 部署指南

## 数据库方案

系统使用 [Turso](https://turso.tech)（libSQL）作为云数据库，本地开发自动回退到文件型 SQLite，无需额外配置。

| 环境 | 数据库 | 持久化 |
|------|--------|--------|
| 本地 | `quiz.db`（文件型 SQLite） | 持久 |
| Vercel | Turso 云数据库 | 持久 |

## 部署步骤

### 1. 创建 Turso 数据库

```bash
# 安装 Turso CLI
npm i -g turso

# 登录
turso auth login

# 创建数据库
turso db create quiz-db

# 获取数据库 URL
turso db show quiz-db --url
# 输出类似: libsql://quiz-db-your-org.turso.io

# 创建认证 Token
turso db tokens create quiz-db
```

### 2. 推送到 Git

```bash
git add .
git commit -m "your commit message"
git push
```

### 3. 连接到 Vercel

**方式 A: Vercel CLI**
```bash
npm i -g vercel
vercel
```

**方式 B: Vercel 网站**
1. 访问 https://vercel.com
2. 使用 GitHub 账号登录
3. "Add New" → "Project"
4. 选择仓库 → "Deploy"

### 4. 配置环境变量

在 Vercel 项目 **Settings → Environment Variables** 中添加：

```env
# 必需
SESSION_SECRET=your-random-secret-here
TURSO_DATABASE_URL=libsql://quiz-db-your-org.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token
ADMIN_TOKEN=your-secure-admin-token

# 邮件（Resend，注册激活和密码重置需要）
RESEND_API_KEY=re_xxxxx
EMAIL_FROM=noreply@yourdomain.com
BASE_URL=https://your-app.vercel.app

# AI（可选）
AI_API_KEY=sk-<your-api-key>
AI_BASE_URL=https://api.deepseek.ai/v1
AI_MODEL=deepseek-reasoner
```

### 5. 重新部署

环境变量修改后需要重新部署才能生效。

## 本地测试

```bash
# 本地启动（使用 quiz.db 文件，不需要 Turso）
npm start

# 模拟连接 Turso
TURSO_DATABASE_URL=libsql://quiz-db-your-org.turso.io \
TURSO_AUTH_TOKEN=your-token \
npm start
```

## 管理后台

部署后访问 `https://your-app.vercel.app/admin`，输入 `ADMIN_TOKEN` 即可进入管理后台。

## 故障排除

### 数据库连接失败

- 确认 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN` 已正确设置
- 确认 Token 未过期（重新生成：`turso db tokens create quiz-db`）
- 查看 Vercel 函数日志确认具体错误

### 邮件发送失败

- 确认 `RESEND_API_KEY` 已设置
- 确认 `EMAIL_FROM` 的域名已在 Resend 中验证
- 未配置时激活链接和重置链接会输出到 Vercel 函数日志

### 管理后台 403

- 确认请求头 `X-Admin-Token` 与 `ADMIN_TOKEN` 环境变量一致
- Vercel CDN 不会 stripping 请求头（之前用 query param 会被 strip）
