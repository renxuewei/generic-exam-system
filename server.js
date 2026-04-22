const express = require('express');
const path = require('path');
const fs = require('fs');
const {
    initialize, getQuestionsBySubject, getRandomQuestions, getSources, insertQuestions,
    importQuizFromJSON, upsertWrongQuestion, getRandomWrongQuestions,
    markCorrect, markWrong, getWrongCount, saveExamHistory, getProgress,
    getWeakDomains, createSubject, getSubjects, getSubjectById,
    updateSubject, deleteSubject, getSubjectQuestionCount, getDB
} = require('./db');
const { generateQuiz } = require('./ai-gen');
const { exec } = require('child_process');

function openBrowser(url) {
    const cmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    exec(cmd);
}

const app = express();
const PORT = 8000;
let serverInstance = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ─── Subject APIs ───

app.get('/api/subjects', (req, res) => {
    const subjects = getSubjects();
    const result = subjects.map(s => ({
        ...s,
        questionCount: getSubjectQuestionCount(s.id),
        wrongCount: getWrongCount(s.id)
    }));
    res.json(result);
});

app.get('/api/subject/:id', (req, res) => {
    const subject = getSubjectById(req.params.id);
    if (!subject) return res.status(404).json({ error: '学科不存在' });
    const questionCount = getSubjectQuestionCount(subject.id);
    const wrongCount = getWrongCount(subject.id);
    res.json({ ...subject, questionCount, wrongCount });
});

app.post('/api/subjects', (req, res) => {
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '学科名称不能为空' });
    try {
        const id = createSubject(name.trim(), description || '');
        res.json({ id, name: name.trim() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/subjects/:id', (req, res) => {
    const { name, description, quizCount } = req.body;
    try {
        updateSubject(parseInt(req.params.id), name, description, quizCount !== undefined ? parseInt(quizCount) : undefined);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/subjects/:id', (req, res) => {
    deleteSubject(parseInt(req.params.id));
    res.json({ success: true });
});

// ─── Quiz APIs ───

app.get('/api/quiz/:subjectId', (req, res) => {
    const subjectId = parseInt(req.params.subjectId);
    const count = req.query.random ? parseInt(req.query.random) : 0;
    const data = count > 0 ? getRandomQuestions(subjectId, count) : getQuestionsBySubject(subjectId);
    if (!data || data.length === 0) {
        return res.status(404).json({ error: '该学科暂无题目' });
    }
    res.json(data);
});

app.get('/api/sources/:subjectId', (req, res) => {
    const sources = getSources(req.params.subjectId);
    res.json(sources);
});

app.post('/api/submit', (req, res) => {
    const { source, wrongQuestions, totalQuestions, correctCount, score, subjectId } = req.body;
    for (const q of wrongQuestions) {
        upsertWrongQuestion(String(q.id), JSON.stringify(q), source, subjectId);
    }
    saveExamHistory(source, totalQuestions, correctCount, score, subjectId);
    res.json({ saved: wrongQuestions.length });
});

// ─── Review APIs ───

app.get('/api/review', (req, res) => {
    const subjectId = req.query.subjectId ? parseInt(req.query.subjectId) : null;
    const count = req.query.count ? parseInt(req.query.count) : 10;
    const questions = getRandomWrongQuestions(count, subjectId);
    res.json(questions);
});

app.post('/api/review/submit', (req, res) => {
    const { results } = req.body;
    let mastered = 0;
    for (const r of results) {
        if (r.isCorrect) {
            if (markCorrect(r.id)) mastered++;
        } else {
            markWrong(r.id);
        }
    }
    res.json({ mastered });
});

// ─── Analytics APIs ───

app.get('/api/progress/:subjectId', (req, res) => {
    const data = getProgress(parseInt(req.params.subjectId));
    res.json(data);
});

app.get('/api/weakness/:subjectId', (req, res) => {
    const data = getWeakDomains(parseInt(req.params.subjectId));
    res.json(data);
});

// ─── AI Generation API ───

app.post('/api/aigen', async (req, res) => {
    const { subjectId, questionCount } = req.body;
    const subject = getSubjectById(subjectId);
    if (!subject) return res.status(404).json({ error: '学科不存在' });

    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        return res.status(400).json({ error: '未配置 AI API，请在服务器上创建 .env 文件' });
    }

    try {
        const count = Math.min(Math.max(parseInt(questionCount) || 65, 1), 200);
        const quizData = await generateQuiz(subject.name, subject.description || '无特殊说明', count);

        const source = String(Date.now()).slice(-6);
        insertQuestions(subjectId, quizData, source);

        const inputsDir = path.join(__dirname, 'inputs');
        if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir);
        fs.writeFileSync(path.join(inputsDir, `${source}.json`), JSON.stringify(quizData, null, 2));

        res.json({ success: true, count: quizData.length, source });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        const subjects = getSubjects();
        const choices = subjects.map(s => {
            const count = getSubjectQuestionCount(s.id);
            const wrongCount = getWrongCount(s.id);
            const suffix = wrongCount > 0 ? ` (${count}题, ${wrongCount}错题)` : ` (${count}题)`;
            return { name: `${s.name}${suffix}`, value: s.id };
        });

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
                createSubject(name.trim(), description.trim());
                console.log(`\n学科「${name.trim()}」创建成功！\n`);
            } catch (err) {
                console.log(`\n创建失败: ${err.message}\n`);
            }
            continue;
        }

        // Subject operations - only import is CLI-only
        const subject = getSubjectById(action);
        const wrongCount = getWrongCount(action);
        const questionCount = getSubjectQuestionCount(action);

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
                const count = importQuizFromJSON(resolved, source, action);
                console.log(`成功导入 ${count} 道试题！`);
            } catch (err) {
                console.log(`导入失败: ${err.message}`);
            }
        }
    }
}

async function main() {
    initialize();
    await startServer();
    console.log(`Web 界面: http://localhost:${PORT}`);

    const inquirer = (await import('inquirer')).default;
    const keepRunning = await subjectMenu(inquirer);
    if (keepRunning === false) {
        console.log('再见！');
        process.exit(0);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
