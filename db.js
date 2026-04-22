const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 使用可写目录：Vercel 上为 /tmp，本地为当前目录
const DB_DIR = process.env.VERCEL ? '/tmp' : __dirname;
const DB_PATH = path.join(DB_DIR, 'quiz.db');
const INPUTS_DIR = path.join(__dirname, 'inputs');
let db;

function initDB() {
    // 确保数据库目录存在
    if (!fs.existsSync(DB_DIR)) {
        try {
            fs.mkdirSync(DB_DIR, { recursive: true });
        } catch (err) {
            console.warn(`Failed to create DB directory ${DB_DIR}:`, err.message);
        }
    }

    // 创建或打开数据库，添加错误处理
    try {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
    } catch (err) {
        console.error(`Failed to initialize database at ${DB_PATH}:`, err.message);
        throw new Error(`Database initialization failed: ${err.message}`);
    }

    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

            CREATE TABLE IF NOT EXISTS subjects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                quiz_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE TABLE IF NOT EXISTS questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id TEXT NOT NULL,
                question_json TEXT NOT NULL,
                source TEXT NOT NULL,
                domain TEXT,
                type TEXT,
                subject_id INTEGER REFERENCES subjects(id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_qid_source
                ON questions(question_id, source);

            CREATE TABLE IF NOT EXISTS wrong_questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id TEXT NOT NULL,
                question_json TEXT NOT NULL,
                source TEXT NOT NULL,
                wrong_count INTEGER DEFAULT 1,
                correct_streak INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                subject_id INTEGER REFERENCES subjects(id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_wq_source
                ON wrong_questions(question_id, source);

            CREATE TABLE IF NOT EXISTS exam_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                total INTEGER NOT NULL,
                correct INTEGER NOT NULL,
                score REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                subject_id INTEGER REFERENCES subjects(id)
            );
        `);
    } catch (err) {
        console.error('Failed to create database tables:', err.message);
        throw new Error(`Database schema creation failed: ${err.message}`);
    }

    return db;
}

/**
 * Check if a column exists in a table
 */
function columnExists(tableName, columnName) {
    const info = db.pragma(`table_info(${tableName})`);
    return info.some(col => col.name === columnName);
}
// ─── Subject CRUD ───

function createSubject(name, description = '') {
    const result = db.prepare('INSERT INTO subjects (name, description) VALUES (?, ?)').run(name, description);
    return result.lastInsertRowid;
}

function getSubjects() {
    return db.prepare('SELECT * FROM subjects ORDER BY id').all();
}

function getSubjectById(id) {
    return db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
}

function updateSubject(id, name, description, quizCount) {
    if (name !== undefined) {
        db.prepare('UPDATE subjects SET name = ? WHERE id = ?').run(name, id);
    }
    if (description !== undefined) {
        db.prepare('UPDATE subjects SET description = ? WHERE id = ?').run(description, id);
    }
    if (quizCount !== undefined) {
        db.prepare('UPDATE subjects SET quiz_count = ? WHERE id = ?').run(quizCount, id);
    }
}

function deleteSubject(id) {
    db.prepare('DELETE FROM exam_history WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM wrong_questions WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM questions WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM subjects WHERE id = ?').run(id);
}

function getSubjectQuestionCount(subjectId) {
    const row = db.prepare('SELECT COUNT(*) as count FROM questions WHERE subject_id = ?').get(subjectId);
    return row.count;
}

// ─── Questions ───

function getQuestionsBySubject(subjectId) {
    const rows = db.prepare(
        'SELECT * FROM questions WHERE subject_id = ? ORDER BY id'
    ).all(subjectId);
    return rows.map(r => JSON.parse(r.question_json));
}

/**
 * Get random N questions for a subject. If count is 0, return all.
 */
function getRandomQuestions(subjectId, count) {
    if (!count || count <= 0) return getQuestionsBySubject(subjectId);
    const rows = db.prepare(
        'SELECT * FROM questions WHERE subject_id = ? ORDER BY RANDOM() LIMIT ?'
    ).all(subjectId, count);
    return rows.map(r => JSON.parse(r.question_json));
}

/**
 * Insert questions for a subject
 */
function insertQuestions(subjectId, quizData, source) {
    const insert = db.prepare(
        'INSERT OR REPLACE INTO questions (question_id, question_json, source, domain, type, subject_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertMany = db.transaction((rows) => {
        for (const row of rows) insert.run(...row);
    });

    const rows = quizData.map(q => [
        String(q.id),
        JSON.stringify(q),
        source,
        q.domain || '',
        q.type || 'single',
        subjectId
    ]);
    insertMany(rows);
    return rows.length;
}

/**
 * Parse a quiz JS file and return the quizData array.
 */
function loadQuizDataFromFile(source) {
    const filePath = path.join(INPUTS_DIR, `${source}.js`);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/(?:const|var|let)\s+quizData\s*=\s*(\[[\s\S]*\])\s*;?\s*$/);
    if (!match) return null;
    try {
        const fn = new Function('return ' + match[1]);
        return fn();
    } catch {
        return null;
    }
}

/**
 * Parse errors-N.txt file
 */
function parseErrorsFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const blocks = content.split('----------------').filter(b => b.trim());
    const results = [];

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        const titleMatch = lines[0].match(/题目\s+(\d+)\s*:\s*(.+)/);
        if (!titleMatch) continue;

        const questionIndex = parseInt(titleMatch[1]);
        const questionText = titleMatch[2].trim();

        let explanation = '';
        for (const line of lines) {
            const expMatch = line.match(/解析:\s*(.+)/);
            if (expMatch) {
                explanation = expMatch[1].trim();
                break;
            }
        }

        results.push({ questionIndex, questionText, explanation });
    }

    return results;
}

/**
 * Import wrong questions from inputs/errors-*.txt files into the database.
 */
function importErrorsFromFiles() {
    const errorFiles = fs.readdirSync(INPUTS_DIR).filter(f => /^errors-\d+\.txt$/.test(f)).sort();
    let totalImported = 0;

    for (const file of errorFiles) {
        const sourceMatch = file.match(/errors-(\d+)\.txt/);
        if (!sourceMatch) continue;
        const source = sourceMatch[1];

        const quizData = loadQuizDataFromFile(source);
        if (!quizData) {
            console.log(`  跳过 ${file}: 找不到对应的 ${source}.js`);
            continue;
        }

        // Find subject_id for this source
        const subject = db.prepare('SELECT id FROM subjects WHERE name = ?').get(source);
        const subjectId = subject ? subject.id : null;

        const errors = parseErrorsFile(path.join(INPUTS_DIR, file));
        let imported = 0;

        for (const err of errors) {
            const qIndex = err.questionIndex - 1;
            if (qIndex < 0 || qIndex >= quizData.length) continue;

            const question = quizData[qIndex];
            if (question.question !== err.questionText) {
                const matched = quizData.find(q => q.id === question.id);
                if (matched) {
                    upsertWrongQuestion(String(matched.id), JSON.stringify(matched), source, subjectId);
                    imported++;
                }
                continue;
            }

            upsertWrongQuestion(String(question.id), JSON.stringify(question), source, subjectId);
            imported++;
        }

        console.log(`  ${file}: ${imported} 道错题已导入`);
        totalImported += imported;
    }

    return totalImported;
}

/**
 * Import all quiz data from inputs/N.js files into the questions table.
 */
function importAllQuizData() {
    const jsFiles = fs.readdirSync(INPUTS_DIR).filter(f => /^\d+\.js$/.test(f)).sort();
    let totalImported = 0;
    for (const file of jsFiles) {
        const source = file.replace('.js', '');
        const quizData = loadQuizDataFromFile(source);
        if (!quizData) {
            console.log(`  跳过 ${file}: 解析失败`);
            continue;
        }
        // Find subject_id for this source
        const subject = db.prepare('SELECT id FROM subjects WHERE name = ?').get(source);
        const subjectId = subject ? subject.id : null;

        const insert = db.prepare(
            'INSERT OR REPLACE INTO questions (question_id, question_json, source, domain, type, subject_id) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertMany = db.transaction((rows) => {
            for (const row of rows) insert.run(...row);
        });

        const rows = quizData.map(q => [
            String(q.id),
            JSON.stringify(q),
            source,
            q.domain || '',
            q.type || 'single',
            subjectId
        ]);
        insertMany(rows);
        console.log(`  ${file}: ${rows.length} 道试题已导入`);
        totalImported += rows.length;
    }
    return totalImported;
}

/**
 * Import quiz data from a JSON file into the questions table.
 */
function importQuizFromJSON(filePath, source, subjectId) {
    const content = fs.readFileSync(filePath, 'utf-8');
    let quizData;
    try {
        quizData = JSON.parse(content);
    } catch {
        const wrapped = `(${content})`;
        quizData = new Function('return ' + wrapped)();
    }
    if (!Array.isArray(quizData)) throw new Error('文件内容必须是一个数组');
    return insertQuestions(subjectId, quizData, source);
}

/**
 * Get all available sources with question counts (legacy, now filtered by subject)
 */
function getSources(subjectId) {
    const rows = db.prepare(
        subjectId
            ? 'SELECT source, COUNT(*) as count FROM questions WHERE subject_id = ? GROUP BY source ORDER BY source'
            : 'SELECT source, COUNT(*) as count FROM questions GROUP BY source ORDER BY source'
    ).all(subjectId);
    return rows;
}

/**
 * Full initialization: create DB
 */
function initialize() {
    initDB();
    return db;
}

function getDB() {
    return db;
}

// ─── Wrong Questions ───

function upsertWrongQuestion(questionId, questionJson, source, subjectId) {
    const existing = db.prepare(
        'SELECT id, wrong_count FROM wrong_questions WHERE question_id = ? AND source = ?'
    ).get(questionId, source);

    if (existing) {
        db.prepare(
            'UPDATE wrong_questions SET wrong_count = wrong_count + 1, correct_streak = 0, subject_id = ? WHERE id = ?'
        ).run(subjectId, existing.id);
    } else {
        db.prepare(
            'INSERT INTO wrong_questions (question_id, question_json, source, subject_id) VALUES (?, ?, ?, ?)'
        ).run(questionId, questionJson, source, subjectId);
    }
}

function getWrongQuestionsBySource(source) {
    return db.prepare(
        'SELECT * FROM wrong_questions WHERE source = ? ORDER BY created_at DESC'
    ).all(source);
}

function getWrongQuestionsBySubject(subjectId) {
    return db.prepare(
        'SELECT * FROM wrong_questions WHERE subject_id = ? ORDER BY created_at DESC'
    ).all(subjectId);
}

function getAllWrongQuestions() {
    return db.prepare('SELECT * FROM wrong_questions ORDER BY created_at DESC').all();
}

function getRandomWrongQuestions(count = 10, subjectId) {
    const rows = db.prepare(
        subjectId
            ? 'SELECT * FROM wrong_questions WHERE subject_id = ? ORDER BY RANDOM() LIMIT ?'
            : 'SELECT * FROM wrong_questions ORDER BY RANDOM() LIMIT ?'
    ).all(subjectId, count);
    return rows.map(row => ({
        ...row,
        question: JSON.parse(row.question_json)
    }));
}

function markCorrect(id) {
    const row = db.prepare(
        'SELECT correct_streak FROM wrong_questions WHERE id = ?'
    ).get(id);

    if (!row) return false;

    const newStreak = row.correct_streak + 1;
    if (newStreak >= 3) {
        db.prepare('DELETE FROM wrong_questions WHERE id = ?').run(id);
        return true;
    }

    db.prepare(
        'UPDATE wrong_questions SET correct_streak = ? WHERE id = ?'
    ).run(newStreak, id);
    return false;
}

function markWrong(id) {
    db.prepare(
        'UPDATE wrong_questions SET wrong_count = wrong_count + 1, correct_streak = 0 WHERE id = ?'
    ).run(id);
}

function getWrongCount(subjectId) {
    const row = subjectId
        ? db.prepare('SELECT COUNT(*) as count FROM wrong_questions WHERE subject_id = ?').get(subjectId)
        : db.prepare('SELECT COUNT(*) as count FROM wrong_questions').get();
    return row.count;
}

// ─── Exam History ───

function saveExamHistory(source, total, correct, score, subjectId) {
    db.prepare(
        'INSERT INTO exam_history (source, total, correct, score, subject_id) VALUES (?, ?, ?, ?, ?)'
    ).run(source, total, correct, score, subjectId);
}

function getProgress(subjectId) {
    const history = subjectId
        ? db.prepare('SELECT * FROM exam_history WHERE subject_id = ? ORDER BY created_at ASC').all(subjectId)
        : db.prepare('SELECT * FROM exam_history ORDER BY created_at ASC').all();

    if (history.length === 0) return { history: [], summary: null };

    const mid = Math.floor(history.length / 2);
    const firstHalf = history.slice(0, mid || 1);
    const secondHalf = history.slice(mid);

    const avg = arr => arr.reduce((s, h) => s + h.score, 0) / arr.length;

    const firstAvg = avg(firstHalf);
    const secondAvg = avg(secondHalf);
    const overallAvg = avg(history);
    const diff = secondAvg - firstAvg;

    let trend;
    if (diff > 3) trend = '上升';
    else if (diff < -3) trend = '下降';
    else trend = '平稳';

    const best = Math.max(...history.map(h => h.score));
    const worst = Math.min(...history.map(h => h.score));

    return {
        history,
        summary: { firstAvg, secondAvg, overallAvg, diff, trend, best, worst, total: history.length }
    };
}

function getWeakDomains(subjectId) {
    const rows = subjectId
        ? db.prepare('SELECT question_json FROM wrong_questions WHERE subject_id = ?').all(subjectId)
        : db.prepare('SELECT question_json FROM wrong_questions').all();

    const domainMap = {};
    for (const row of rows) {
        let q;
        try { q = JSON.parse(row.question_json); } catch { continue; }
        const domain = q.domain || '未知';
        domainMap[domain] = (domainMap[domain] || 0) + 1;
    }

    const domainTotals = db.prepare(
        subjectId
            ? "SELECT domain, COUNT(*) as total FROM questions WHERE domain != '' AND subject_id = ? GROUP BY domain"
            : "SELECT domain, COUNT(*) as total FROM questions WHERE domain != '' GROUP BY domain"
    ).all(subjectId);
    const totalMap = {};
    for (const d of domainTotals) {
        totalMap[d.domain] = d.total;
    }

    const result = Object.entries(domainMap).map(([domain, wrongCount]) => {
        const total = totalMap[domain] || 0;
        const errorRate = total > 0 ? (wrongCount / total * 100).toFixed(1) : 'N/A';
        return { domain, wrongCount, total, errorRate };
    });

    result.sort((a, b) => b.wrongCount - a.wrongCount);
    return result;
}

module.exports = {
    initDB,
    initialize,
    getDB,
    loadQuizDataFromFile,
    getQuestionsBySubject,
    getRandomQuestions,
    getSources,
    insertQuestions,
    importQuizFromJSON,
    upsertWrongQuestion,
    getWrongQuestionsBySource,
    getWrongQuestionsBySubject,
    getAllWrongQuestions,
    getRandomWrongQuestions,
    markCorrect,
    markWrong,
    getWrongCount,
    saveExamHistory,
    getProgress,
    getWeakDomains,
    // Subject CRUD
    createSubject,
    getSubjects,
    getSubjectById,
    updateSubject,
    deleteSubject,
    getSubjectQuestionCount
};
