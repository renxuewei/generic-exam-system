# 🎓 通用题库系统 (Generic Exam System)

一个功能完整的多学科题库和考试系统，支持AI智能生成试题、错题管理、学习进度追踪等功能。

## ✨ 主要特性

- **📚 多学科管理**: 支持创建和管理多个学科的题库
- **🤖 AI智能生成**: 基于OpenAI兼容API自动生成高质量模拟题
- **📝 完整考试系统**: 支持在线做题、自动评卷、答题记录
- **❌ 错题管理**: 自动收集和管理答错的题目
- **📊 学习分析**: 
  - 学习进度统计
  - 弱点域分析
  - 做题历史记录
  - 错题率统计
- **💾 数据导入**: 支持JSON格式题目批量导入
- **🎯 灵活查询**: 按学科、题型、难度等多维度查询题目

## 🚀 快速开始

### 前置要求

- Node.js (v14 或更高版本)
- npm 或 yarn
- OpenAI API密钥（用于AI生成题目功能）

### 安装依赖

```bash
npm install
```

### 环境配置

创建 `.env` 文件配置AI服务：

```env
AI_API_KEY=your_openai_api_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-3.5-turbo
```

> 💡 **提示**: 也支持OpenAI兼容的第三方API服务（如LM Studio等）

### 启动应用

```bash
npm start
```

或使用启动脚本（Windows）：

```bash
start.cmd
```

应用将在 `http://localhost:8000` 启动

## 📁 项目结构

```
generic-exam-sys/
├── server.js              # Express 服务器主文件
├── db.js                  # SQLite 数据库操作模块
├── ai-gen.js              # AI相关功能（调用OpenAI API）
├── package.json           # 项目配置和依赖
├── prompt.txt             # AI生成题目的系统提示词
├── .env                   # 环境变量配置（需要手动创建）
├── start.cmd              # Windows启动脚本
│
├── public/                # 前端文件
│   └── index.html         # 单页应用主页面
│
└── inputs/                # 数据输入文件夹
    ├── *.js               # JavaScript格式题目文件
    ├── *.json             # JSON格式题目文件
    └── errors-*.txt       # 错误日志
```

## 🔧 核心功能API

### 学科管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/subjects` | GET | 获取所有学科列表 |
| `/api/subject/:id` | GET | 获取特定学科详情 |
| `/api/subject` | POST | 创建新学科 |
| `/api/subject/:id` | PUT | 更新学科 |
| `/api/subject/:id` | DELETE | 删除学科 |

### 题目管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/questions/by-subject/:subject` | GET | 按学科获取题目 |
| `/api/questions/random` | GET | 获取随机题目 |
| `/api/questions/import` | POST | 导入题目 |
| `/api/quiz/generate` | POST | AI生成模拟题 |

### 学习追踪

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/exam/history` | POST | 保存考试记录 |
| `/api/progress/:subject` | GET | 获取学习进度 |
| `/api/wrong-questions` | GET | 获取错题集 |
| `/api/weak-domains/:subject` | GET | 分析弱点域 |

## 💾 数据格式

### 题目JSON格式

```json
[
  {
    "id": 1,
    "type": "single",
    "domain": "领域名",
    "question": "题目内容",
    "options": {
      "A": "选项A",
      "B": "选项B",
      "C": "选项C",
      "D": "选项D"
    },
    "correct": ["B"],
    "explanation": "解析说明"
  },
  {
    "id": 2,
    "type": "multiple",
    "domain": "领域名",
    "question": "题目内容（选两项）",
    "options": {
      "A": "选项A",
      "B": "选项B",
      "C": "选项C",
      "D": "选项D",
      "E": "选项E"
    },
    "correct": ["B", "E"],
    "explanation": "解析说明"
  }
]
```

### 支持的题型

- `single` - 单选题
- `multiple` - 多选题
- `true-false` - 判断题
- `fill-blank` - 填空题
- `short-answer` - 简答题

## 🎯 使用场景

1. **教育机构**: 创建和管理各类学科题库
2. **考试培训**: 快速生成模拟题进行自适应学习
3. **学生自学**: 错题管理和弱点分析助力高效学习
4. **题库共享**: 支持题目导入和数据导出

## 🛠️ 开发说明

### 主要依赖

- **express**: Web框架，处理HTTP请求
- **better-sqlite3**: 轻量级SQLite数据库
- **inquirer**: 命令行交互工具

### 运行开发模式

```bash
npm start
```

### 项目配置

- 服务器端口: 8000
- 数据库: SQLite (data.db)
- 前端: 单页应用 (SPA)

## 📊 数据库架构

系统使用SQLite数据库，包含以下主要表：

- **subjects** - 学科信息
- **questions** - 题目库
- **wrong_questions** - 错题集
- **exam_history** - 考试历史
- **progress** - 学习进度

## 🔐 注意事项

1. **API密钥安全**: 不要将 `.env` 文件提交到版本控制系统
2. **数据备份**: 定期备份SQLite数据库文件
3. **题目质量**: AI生成的题目需要人工审核后方可使用
4. **隐私保护**: 确保题目数据符合版权和隐私要求

## 📝 许可证

MIT

## 🤝 贡献

欢迎提交问题报告和功能建议！

## 📞 联系方式

如有问题或建议，欢迎开issue或联系项目维护者。

---

**最后更新**: 2026年4月
**版本**: 2.0.0
