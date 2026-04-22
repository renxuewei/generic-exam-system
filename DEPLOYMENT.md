# Vercel 部署指南

## 部署前准备

本应用已针对 Vercel 部署进行了优化。主要改进包括：

### 1. 数据库存储位置

- **本地开发**: 数据库存储在项目根目录 (`quiz.db`)
- **Vercel 生产**: 数据库存储在 `/tmp` 目录（Vercel 的唯一可写目录）

数据库自动检测运行环境，无需手动配置。

### 2. 环境特性差异

| 特性 | 本地 | Vercel |
|------|------|--------|
| 交互式菜单 | ✅ 支持 | ❌ 不支持（CLI环境不可用） |
| Web 界面 | ✅ 支持 | ✅ 支持 |
| 数据持久化 | ✅ 持久（文件系统） | ⚠️ 临时（每次部署重置） |

### 3. 数据持久化问题

**重要**: Vercel 无服务函数是无状态的，每次部署都会重置 `/tmp` 目录。这意味着：

- 题库数据不会在部署间保留
- 用户进度、错题等会在部署后丢失

**解决方案**（选择其一）:

#### 方案 A: 使用外部数据库（推荐生产环境）
- 改用 PostgreSQL / MySQL（例如 Neon、Planetscale）
- 改用 MongoDB（例如 MongoDB Atlas）

#### 方案 B: 容器化部署（推荐开发/演示）
- 使用 Railway、Render 或 Fly.io（支持持久化存储）
- 使用 Docker + SQLite

#### 方案 C: 预加载数据
- 在部署时从 inputs 目录加载题目数据
- 修改初始化脚本自动导入题库

## Vercel 部署步骤

### 1. 推送到 Git

```bash
git add .
git commit -m "优化 Vercel 部署"
git push
```

### 2. 连接到 Vercel

选择以下任一方式：

**方式 A: Vercel CLI**
```bash
npm i -g vercel
vercel
```

**方式 B: Vercel 网站**
1. 访问 https://vercel.com
2. 使用 GitHub 账号登录
3. "Add New" → "Project"
4. 选择你的仓库
5. 点击 "Deploy"

### 3. 配置环境变量（如需要）

在 Vercel 项目设置中添加：

```env
AI_API_KEY=your_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-3.5-turbo
```

### 4. 部署完成

应用将在以下 URL 可用:
```
https://your-project.vercel.app
```

## 本地测试 Vercel 环境

### 使用 Vercel CLI 本地运行

```bash
# 安装 Vercel CLI
npm i -g vercel

# 本地运行 Vercel 环境
vercel dev
```

应用将运行在 `http://localhost:3000`（Vercel 默认端口）

### 模拟 Vercel 环境

```bash
# 设置 VERCEL 环境变量
export VERCEL=true
npm start
```

## 故障排除

### 问题 1: SqliteError: unable to open database file

**原因**: 数据库目录不可写

**解决方案**:
- ✅ 已在 `db.js` 中自动处理
- 确保代码已更新到最新版本

### 问题 2: 无法导入题库数据

在 Vercel 无服务环境中，文件系统是只读的（除了 `/tmp`）。

**解决方案**:
- 修改 `importAllQuizData()` 以支持 `/tmp` 路径
- 或在部署前在本地预处理数据

### 问题 3: 数据在重新部署后消失

这是正常的，因为 `/tmp` 在每次部署都会重置。

**解决方案**:
- 使用外部数据库（见上方 "方案 A"）
- 将题库数据存储在项目源代码中
- 使用容器化部署（见上方 "方案 B"）

## 从 SQLite 迁移到外部数据库

如果你需要在 Vercel 上保持数据持久化，推荐迁移到云数据库：

### 推荐方案

1. **PostgreSQL** (Neon / Railway)
   - 稳定可靠
   - 提供免费试用
   - 易于扩展

2. **MongoDB** (MongoDB Atlas)
   - 灵活的数据模型
   - 免费永久层
   - 自动备份

3. **MySQL** (Planetscale)
   - MySQL 兼容
   - 很好的 Vercel 集成
   - 免费计划

## 开发配置

### package.json 脚本

```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "vercel dev",
    "test": "node -e \"console.log('Add tests here')\""
  }
}
```

### vercel.json 配置

项目中的 `vercel.json` 已配置为:
- 使用 Node.js 运行时
- 将所有路由代理到 Express 应用
- 设置生产环境标志

## 监控和日志

在 Vercel 仪表板查看：
- 部署历史
- 函数日志（实时）
- 环境变量
- 域名配置

访问日志:
```
Vercel 项目 → Analytics → Logs
```

## 最佳实践

✅ **推荐做法**:
- 使用 `.vercelignore` 排除不需要的文件
- 在生产环境使用外部数据库
- 定期备份数据
- 使用环境变量存储敏感信息
- 使用 Vercel 的内置分析功能监控性能

❌ **避免**:
- 依赖 `/tmp` 进行持久化存储
- 在 `vercel.json` 中硬编码敏感信息
- 过多的依赖项（影响冷启动）
- 运行长时间后台任务（无服务限制）

## 更多资源

- [Vercel 文档](https://vercel.com/docs)
- [Node.js Vercel 部署](https://vercel.com/docs/concepts/functions/serverless-functions/supported-languages#node.js)
- [Vercel CLI 文档](https://vercel.com/cli)
