const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Load .env file into process.env (no dotenv dependency needed)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim();
            if (!(key in process.env)) process.env[key] = val;
        }
    });
}
const dbModule = require('./db');
const {
    createDbClient, initialize, getClient, getDB,
    getQuestionsBySubject, getRandomQuestions, getSources, insertQuestions,
    importQuizFromJSON, upsertWrongQuestion, getRandomWrongQuestions,
    markCorrect, markWrong, getWrongCount, saveExamHistory, getProgress,
    getWeakDomains, createSubject, getSubjects, getSubjectById,
    updateSubject, deleteSubject, getSubjectQuestionCount,
    createUser, findUserByEmail, findUserByToken, activateUser, getUserById,
    getAllUsers, setUserDisabled, getUserSubjects,
    exportUserData, restoreUserData
} = dbModule;
const { sendActivationEmail } = require('./email');
const { generateQuiz } = require('./ai-gen');
const { exec } = require('child_process');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Create DB client synchronously ───
createDbClient();

// ─── libSQL Session Store ───
class LibsqlSessionStore extends session.Store {
    constructor(dbClient) {
        super();
        this.db = dbClient;
        // Periodically clean expired sessions
        this._cleanup = setInterval(() => {
            this.db.execute('DELETE FROM sessions WHERE expired < ?', [Date.now()]).catch(() => {});
        }, 10 * 60 * 1000); // every 10 min
    }

    get(sid, callback) {
        this.db.execute(
            'SELECT sess FROM sessions WHERE sid = ? AND expired > ?',
            [sid, Date.now()]
        ).then(result => {
            if (!result.rows.length) return callback(null, null);
            callback(null, JSON.parse(result.rows[0].sess));
        }).catch(callback);
    }

    set(sid, sess, callback) {
        const maxAge = (sess.cookie && sess.cookie.maxAge) || 30 * 24 * 60 * 60 * 1000;
        const expired = Date.now() + maxAge;
        this.db.execute(
            'INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?, ?, ?)',
            [sid, expired, JSON.stringify(sess)]
        ).then(() => callback(null)).catch(callback);
    }

    destroy(sid, callback) {
        this.db.execute(
            'DELETE FROM sessions WHERE sid = ?', [sid]
        ).then(() => callback(null)).catch(callback);
    }
}

function openBrowser(url) {
    const cmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    exec(cmd);
}

const app = express();
const PORT = 8000;
let serverInstance = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB init middleware: wait for tables to be created ───
let _initPromise = initialize();

app.use(async (req, res, next) => {
    try {
        await _initPromise;
    } catch (err) {
        return res.status(500).json({ error: '数据库初始化失败: ' + err.message });
    }
    next();
});

// ─── Session middleware ───
const _sessionStore = new LibsqlSessionStore(getClient());
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    store: _sessionStore,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: process.env.NODE_ENV === 'production' ? 'lax' : undefined
    }
}));

// SPA fallback: serve index.html for all non-API routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/exam', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/review', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/activate', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Auth Routes (public) ───

app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;

    // Validate
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }
    if (!password || password.length < 6) {
        return res.status(400).json({ error: '密码长度至少 6 位' });
    }

    // Check duplicate
    const existing = await findUserByEmail(email.toLowerCase().trim());
    if (existing) {
        return res.status(400).json({ error: '该邮箱已注册' });
    }

    try {
        const hash = await bcrypt.hash(password, 12);
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const userId = await createUser(email.toLowerCase().trim(), hash, token, expiresAt);

        // Send activation email
        await sendActivationEmail(email.toLowerCase().trim(), token);

        res.json({ success: true, message: '注册成功，请查收激活邮件' });
    } catch (err) {
        res.status(500).json({ error: '注册失败：' + err.message });
    }
});

app.post('/api/auth/activate', async (req, res) => {
    const { token } = req.body;
    if (!token) {
        return res.status(400).json({ error: '缺少激活令牌' });
    }

    const user = await findUserByToken(token);
    if (!user) {
        return res.status(400).json({ error: '无效的激活链接' });
    }

    if (user.is_active) {
        return res.json({ success: true, message: '账户已激活，请直接登录' });
    }

    if (new Date(user.activation_expires_at) < new Date()) {
        return res.status(400).json({ error: '激活链接已过期，请重新注册' });
    }

    await activateUser(user.id);
    res.json({ success: true, message: '账户激活成功！请登录' });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: '请输入邮箱和密码' });
    }

    const user = await findUserByEmail(email.toLowerCase().trim());
    if (!user) {
        return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
        return res.status(401).json({ error: '邮箱或密码错误' });
    }

    if (!user.is_active) {
        return res.status(403).json({ error: '账户未激活，请查收激活邮件' });
    }

    if (user.is_disabled) {
        return res.status(403).json({ error: '账户已被禁用，请联系管理员' });
    }

    req.session.userId = user.id;
    req.session.email = user.email;
    res.json({ success: true, user: { id: user.id, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

app.get('/api/auth/me', async (req, res) => {
    if (!req.session.userId) {
        return res.json({ user: null });
    }
    const user = await getUserById(req.session.userId);
    res.json({ user: user || null });
});

// ─── Auth Middleware ───

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
    }
    req.userId = req.session.userId;
    next();
}

function requireAdmin(req, res, next) {
    if (!process.env.ADMIN_TOKEN) {
        return res.status(404).json({ error: '管理功能未启用' });
    }
    if (req.session.isAdmin) return next();
    const token = req.query.token || req.headers['x-admin-token'];
    if (token === process.env.ADMIN_TOKEN) {
        req.session.isAdmin = true;
        return next();
    }
    return res.status(403).json({ error: '无效的管理员令牌', code: 'ADMIN_AUTH_REQUIRED' });
}

// ─── Admin Routes (before global requireAuth) ───

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    res.json(await getAllUsers());
});

app.put('/api/admin/users/:id/toggle', requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    if (userId === 1) return res.status(400).json({ error: '不能操作系统账户' });
    const users = await getAllUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    await setUserDisabled(userId, !user.is_disabled);
    res.json({ success: true, is_disabled: !user.is_disabled });
});

app.get('/api/admin/users/:id/subjects', requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    try {
        const subjects = await getUserSubjects(userId);
        const enriched = [];
        for (const s of subjects) {
            const progress = await getProgress(userId, s.id);
            enriched.push({ ...s, progress: progress.summary || null });
        }
        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// All API routes below require auth
app.use('/api', requireAuth);

// ─── Subject APIs ───

app.get('/api/subjects', async (req, res) => {
    const subjects = await getSubjects(req.userId);
    const result = [];
    for (const s of subjects) {
        const questionCount = await getSubjectQuestionCount(req.userId, s.id);
        const wrongCount = await getWrongCount(req.userId, s.id);
        result.push({ ...s, questionCount, wrongCount });
    }
    res.json(result);
});

app.get('/api/subject/:id', async (req, res) => {
    const subject = await getSubjectById(req.userId, parseInt(req.params.id));
    if (!subject) return res.status(404).json({ error: '学科不存在' });
    const questionCount = await getSubjectQuestionCount(req.userId, subject.id);
    const wrongCount = await getWrongCount(req.userId, subject.id);
    res.json({ ...subject, questionCount, wrongCount });
});

app.post('/api/subjects', async (req, res) => {
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '学科名称不能为空' });
    try {
        const id = await createSubject(req.userId, name.trim(), description || '');
        res.json({ id, name: name.trim() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/subjects/:id', async (req, res) => {
    const { name, description, quizCount } = req.body;
    try {
        await updateSubject(req.userId, parseInt(req.params.id), name, description, quizCount !== undefined ? parseInt(quizCount) : undefined);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/subjects/:id', async (req, res) => {
    await deleteSubject(req.userId, parseInt(req.params.id));
    res.json({ success: true });
});

// ─── Quiz APIs ───

app.get('/api/quiz/:subjectId', async (req, res) => {
    const subjectId = parseInt(req.params.subjectId);
    const count = req.query.random ? parseInt(req.query.random) : 0;
    const data = count > 0 ? await getRandomQuestions(req.userId, subjectId, count) : await getQuestionsBySubject(req.userId, subjectId);
    if (!data || data.length === 0) {
        return res.status(404).json({ error: '该学科暂无题目' });
    }
    res.json(data);
});

app.get('/api/sources/:subjectId', async (req, res) => {
    const sources = await getSources(req.userId, req.params.subjectId);
    res.json(sources);
});

app.post('/api/submit', async (req, res) => {
    const { source, wrongQuestions, totalQuestions, correctCount, score, subjectId } = req.body;
    for (const q of wrongQuestions) {
        await upsertWrongQuestion(req.userId, String(q.id), JSON.stringify(q), source, subjectId);
    }
    await saveExamHistory(req.userId, source, totalQuestions, correctCount, score, subjectId);
    res.json({ saved: wrongQuestions.length });
});

// ─── Review APIs ───

app.get('/api/review', async (req, res) => {
    const subjectId = req.query.subjectId ? parseInt(req.query.subjectId) : null;
    const count = req.query.count ? parseInt(req.query.count) : 10;
    const questions = await getRandomWrongQuestions(req.userId, count, subjectId);
    res.json(questions);
});

app.post('/api/review/submit', async (req, res) => {
    const { results } = req.body;
    let mastered = 0;
    for (const r of results) {
        if (r.isCorrect) {
            if (await markCorrect(req.userId, r.id)) mastered++;
        } else {
            await markWrong(req.userId, r.id);
        }
    }
    res.json({ mastered });
});

// ─── Analytics APIs ───

app.get('/api/progress/:subjectId', async (req, res) => {
    const data = await getProgress(req.userId, parseInt(req.params.subjectId));
    res.json(data);
});

app.get('/api/weakness/:subjectId', async (req, res) => {
    const data = await getWeakDomains(req.userId, parseInt(req.params.subjectId));
    res.json(data);
});

// ─── AI Generation API ───

app.post('/api/aigen', async (req, res) => {
    const { subjectId, questionCount } = req.body;
    const subject = await getSubjectById(req.userId, subjectId);
    if (!subject) return res.status(404).json({ error: '学科不存在' });

    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        return res.status(400).json({ error: '未配置 AI API，请在服务器上创建 .env 文件' });
    }

    try {
        const count = Math.min(Math.max(parseInt(questionCount) || 65, 1), 200);
        const quizData = await generateQuiz(subject.name, subject.description || '无特殊说明', count);

        const source = String(Date.now()).slice(-6);
        await insertQuestions(req.userId, subjectId, quizData, source);

        const inputsDir = path.join(__dirname, 'inputs');
        if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir);
        fs.writeFileSync(path.join(inputsDir, `${source}.json`), JSON.stringify(quizData, null, 2));

        res.json({ success: true, count: quizData.length, source });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Backup / Restore APIs ───

app.get('/api/backup/export', async (req, res) => {
    try {
        const data = await exportUserData(req.userId);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=quiz-backup-' + new Date().toISOString().slice(0, 10) + '.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.append(JSON.stringify(data.manifest, null, 2), { name: 'manifest.json' });
        archive.append(JSON.stringify(data.subjects, null, 2), { name: 'subjects.json' });
        archive.append(JSON.stringify(data.questions, null, 2), { name: 'questions.json' });
        archive.append(JSON.stringify(data.wrong_questions, null, 2), { name: 'wrong_questions.json' });
        archive.append(JSON.stringify(data.exam_history, null, 2), { name: 'exam_history.json' });
        archive.finalize();
        archive.on('error', (err) => {
            console.error('Backup error:', err);
            if (!res.headersSent) res.status(500).json({ error: '备份失败' });
        });
    } catch (err) {
        res.status(500).json({ error: '备份失败: ' + err.message });
    }
});

app.post('/api/backup/restore', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请选择备份文件' });
    try {
        const zip = new AdmZip(req.file.buffer);
        const fileNames = zip.getEntries().map(e => e.entryName);
        if (!fileNames.includes('manifest.json') || !fileNames.includes('subjects.json')) {
            return res.status(400).json({ error: '无效的备份文件：缺少必要文件' });
        }
        const manifest = JSON.parse(zip.readAsText('manifest.json'));
        const subjects = JSON.parse(zip.readAsText('subjects.json'));
        const questions = fileNames.includes('questions.json') ? JSON.parse(zip.readAsText('questions.json')) : [];
        const wrongQuestions = fileNames.includes('wrong_questions.json') ? JSON.parse(zip.readAsText('wrong_questions.json')) : [];
        const examHistory = fileNames.includes('exam_history.json') ? JSON.parse(zip.readAsText('exam_history.json')) : [];
        const result = await restoreUserData(req.userId, { manifest, subjects, questions, wrong_questions: wrongQuestions, exam_history: examHistory });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ error: '恢复失败: ' + err.message });
    }
});

// Start HTTP server
function startServer() {
    return new Promise((resolve) => {
        if (serverInstance) return resolve();
        serverInstance = app.listen(PORT, () => resolve());
    });
}

// ─── CLI (still works for import and local use) ───

async function subjectMenu(inquirer) {
    while (true) {
        const subjects = await getSubjects(1); // CLI uses migrated user
        const choices = [];
        for (const s of subjects) {
            const count = await getSubjectQuestionCount(1, s.id);
            const wrongCount = await getWrongCount(1, s.id);
            const suffix = wrongCount > 0 ? ` (${count}题, ${wrongCount}错题)` : ` (${count}题)`;
            choices.push({ name: `${s.name}${suffix}`, value: s.id });
        }

        choices.push(
            new inquirer.Separator(),
            { name: '+ 创建新学科', value: '__create__' },
            { name: '退出', value: '__exit__' }
        );

        console.log('');
        console.log('  通用题库系统');
        console.log('  (Web 界面已启动: http://localhost:' + PORT + ')');
        console.log('');

        const { action } = await inquirer.prompt([
            { type: 'list', name: 'action', message: '选择操作：', choices }
        ]);

        if (action === '__exit__') return false;

        if (action === '__create__') {
            const { name } = await inquirer.prompt([
                { type: 'input', name: 'name', message: '学科名称：', validate: (v) => v.trim() || '请输入学科名称' }
            ]);
            const { description } = await inquirer.prompt([
                { type: 'input', name: 'description', message: '学科描述（可选）：', default: '' }
            ]);
            try {
                await createSubject(1, name.trim(), description.trim());
                console.log(`\n学科「${name.trim()}」创建成功！\n`);
            } catch (err) {
                console.log(`\n创建失败: ${err.message}\n`);
            }
            continue;
        }

        // Subject operations - only import is CLI-only
        const subject = await getSubjectById(1, action);
        const wrongCount = await getWrongCount(1, action);
        const questionCount = await getSubjectQuestionCount(1, action);

        const opChoices = [
            { name: '导入试题 (JSON 文件)', value: 'import' },
            new inquirer.Separator(),
            { name: '返回', value: 'back' },
            { name: '退出', value: 'exit' }
        ];

        const { op } = await inquirer.prompt([
            { type: 'list', name: 'op', message: `${subject.name} (${questionCount}题, ${wrongCount}错题) - 选择操作：`, choices: opChoices }
        ]);

        if (op === 'exit') return false;
        if (op === 'back') continue;

        if (op === 'import') {
            const { filePath } = await inquirer.prompt([
                { type: 'input', name: 'filePath', message: '输入 JSON 文件路径：' }
            ]);
            const resolved = path.resolve(filePath);
            if (!fs.existsSync(resolved)) { console.log(`文件不存在: ${resolved}`); continue; }
            const baseName = path.basename(resolved, '.json');
            const { source } = await inquirer.prompt([
                { type: 'input', name: 'source', message: '题集标识：', default: baseName }
            ]);
            try {
                const count = await importQuizFromJSON(1, resolved, source, action);
                console.log(`成功导入 ${count} 道试题！`);
            } catch (err) {
                console.log(`导入失败: ${err.message}`);
            }
        }
    }
}

async function main() {
    // Wait for DB initialization
    await _initPromise;
    console.log('数据库初始化成功');

    // Vercel 环境中导出 app，不启动 server
    if (process.env.VERCEL) {
        module.exports = app;
        return;
    }

    await startServer();

    console.log(`Web 界面: http://localhost:${PORT}`);

    const inquirer = (await import('inquirer')).default;
    const keepRunning = await subjectMenu(inquirer);
    if (keepRunning === false) {
        console.log('再见！');
        process.exit(0);
    }
}

// Export for Vercel (before async main completes)
if (process.env.VERCEL) {
    module.exports = app;
}

main().catch(err => {
    console.error('启动失败:', err.message);
    process.exit(1);
});
