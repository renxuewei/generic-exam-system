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

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_active INTEGER DEFAULT 0,
                activation_token TEXT,
                activation_expires_at TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

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

            CREATE TABLE IF NOT EXISTS sessions (
                sid TEXT PRIMARY KEY,
                expired INTEGER NOT NULL,
                sess TEXT NOT NULL
            );
        `);

        // ─── Migration: add user_id to existing tables ───
        runMigration();

    } catch (err) {
        console.error('Failed to create database tables:', err.message);
        throw new Error(`Database schema creation failed: ${err.message}`);
    }

    return db;
}

/**
 * Run schema migration to add user_id columns and indexes
 */
function runMigration() {
    // Insert migration user (id=1) to preserve foreign key integrity
    db.prepare(`
        INSERT OR IGNORE INTO users (id, email, password_hash, is_active, activation_token, created_at)
        VALUES (1, 'migrated@system', 'no-login', 1, NULL, datetime('now', 'localtime'))
    `).run();

    // Add user_id to subjects
    if (!columnExists('subjects', 'user_id')) {
        db.prepare('ALTER TABLE subjects ADD COLUMN user_id INTEGER DEFAULT 1').run();
    }
    // Add user_id to questions
    if (!columnExists('questions', 'user_id')) {
        db.prepare('ALTER TABLE questions ADD COLUMN user_id INTEGER DEFAULT 1').run();
    }
    // Add user_id to wrong_questions
    if (!columnExists('wrong_questions', 'user_id')) {
        db.prepare('ALTER TABLE wrong_questions ADD COLUMN user_id INTEGER DEFAULT 1').run();
    }
    // Add user_id to exam_history
    if (!columnExists('exam_history', 'user_id')) {
        db.prepare('ALTER TABLE exam_history ADD COLUMN user_id INTEGER DEFAULT 1').run();
    }

    // Add is_disabled to users
    if (!columnExists('users', 'is_disabled')) {
        db.prepare('ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0').run();
    }

    // Recreate composite indexes with user_id
    db.exec(`
        DROP INDEX IF EXISTS idx_qid_source;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_qid_source_user
            ON questions(question_id, source, user_id);

        DROP INDEX IF EXISTS idx_wq_source;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_wq_source_user
            ON wrong_questions(question_id, source, user_id);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_subject_user_name
            ON subjects(user_id, name);
    `);
}

/**
 * Check if a column exists in a table
 */
function columnExists(tableName, columnName) {
    const info = db.pragma(`table_info(${tableName})`);
    return info.some(col => col.name === columnName);
}

// ─── User CRUD ───

function createUser(email, passwordHash, token, expiresAt) {
    const result = db.prepare(
        'INSERT INTO users (email, password_hash, activation_token, activation_expires_at) VALUES (?, ?, ?, ?)'
    ).run(email, passwordHash, token, expiresAt);
    return result.lastInsertRowid;
}

function findUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function findUserByToken(token) {
    return db.prepare('SELECT * FROM users WHERE activation_token = ?').get(token);
}

function activateUser(userId) {
    db.prepare(
        'UPDATE users SET is_active = 1, activation_token = NULL, activation_expires_at = NULL WHERE id = ?'
    ).run(userId);
}

function getUserById(id) {
    return db.prepare('SELECT id, email, is_active, created_at FROM users WHERE id = ?').get(id);
}

// ─── Subject CRUD ───

function createSubject(userId, name, description = '') {
    const result = db.prepare(
        'INSERT INTO subjects (name, description, user_id) VALUES (?, ?, ?)'
    ).run(name, description, userId);
    return result.lastInsertRowid;
}

function getSubjects(userId) {
    return db.prepare('SELECT * FROM subjects WHERE user_id = ? ORDER BY id').all(userId);
}

function getSubjectById(userId, id) {
    return db.prepare('SELECT * FROM subjects WHERE id = ? AND user_id = ?').get(id, userId);
}

function updateSubject(userId, id, name, description, quizCount) {
    if (name !== undefined) {
        db.prepare('UPDATE subjects SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId);
    }
    if (description !== undefined) {
        db.prepare('UPDATE subjects SET description = ? WHERE id = ? AND user_id = ?').run(description, id, userId);
    }
    if (quizCount !== undefined) {
        db.prepare('UPDATE subjects SET quiz_count = ? WHERE id = ? AND user_id = ?').run(quizCount, id, userId);
    }
}

function deleteSubject(userId, id) {
    db.prepare('DELETE FROM exam_history WHERE subject_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM wrong_questions WHERE subject_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM questions WHERE subject_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM subjects WHERE id = ? AND user_id = ?').run(id, userId);
}

function getSubjectQuestionCount(userId, subjectId) {
    const row = db.prepare(
        'SELECT COUNT(*) as count FROM questions WHERE subject_id = ? AND user_id = ?'
    ).get(subjectId, userId);
    return row.count;
}

// ─── Questions ───

function getQuestionsBySubject(userId, subjectId) {
    const rows = db.prepare(
        'SELECT * FROM questions WHERE subject_id = ? AND user_id = ? ORDER BY id'
    ).all(subjectId, userId);
    return rows.map(r => JSON.parse(r.question_json));
}

/**
 * Get random N questions for a subject. If count is 0, return all.
 */
function getRandomQuestions(userId, subjectId, count) {
    if (!count || count <= 0) return getQuestionsBySubject(userId, subjectId);
    const rows = db.prepare(
        'SELECT * FROM questions WHERE subject_id = ? AND user_id = ? ORDER BY RANDOM() LIMIT ?'
    ).all(subjectId, userId, count);
    return rows.map(r => JSON.parse(r.question_json));
}

/**
 * Insert questions for a subject
 */
function insertQuestions(userId, subjectId, quizData, source) {
    const insert = db.prepare(
        'INSERT OR REPLACE INTO questions (question_id, question_json, source, domain, type, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
        subjectId,
        userId
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
function importErrorsFromFiles(userId) {
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
        const subject = db.prepare('SELECT id FROM subjects WHERE name = ? AND user_id = ?').get(source, userId);
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
                    upsertWrongQuestion(userId, String(matched.id), JSON.stringify(matched), source, subjectId);
                    imported++;
                }
                continue;
            }

            upsertWrongQuestion(userId, String(question.id), JSON.stringify(question), source, subjectId);
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
function importAllQuizData(userId) {
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
        const subject = db.prepare('SELECT id FROM subjects WHERE name = ? AND user_id = ?').get(source, userId);
        const subjectId = subject ? subject.id : null;

        const insert = db.prepare(
            'INSERT OR REPLACE INTO questions (question_id, question_json, source, domain, type, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
            subjectId,
            userId
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
function importQuizFromJSON(userId, filePath, source, subjectId) {
    const content = fs.readFileSync(filePath, 'utf-8');
    let quizData;
    try {
        quizData = JSON.parse(content);
    } catch {
        const wrapped = `(${content})`;
        quizData = new Function('return ' + wrapped)();
    }
    if (!Array.isArray(quizData)) throw new Error('文件内容必须是一个数组');
    return insertQuestions(userId, subjectId, quizData, source);
}

/**
 * Get all available sources with question counts (legacy, now filtered by subject)
 */
function getSources(userId, subjectId) {
    const rows = db.prepare(
        subjectId
            ? 'SELECT source, COUNT(*) as count FROM questions WHERE subject_id = ? AND user_id = ? GROUP BY source ORDER BY source'
            : 'SELECT source, COUNT(*) as count FROM questions WHERE user_id = ? GROUP BY source ORDER BY source'
    ).all(subjectId, userId);
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

function upsertWrongQuestion(userId, questionId, questionJson, source, subjectId) {
    const existing = db.prepare(
        'SELECT id, wrong_count FROM wrong_questions WHERE question_id = ? AND source = ? AND user_id = ?'
    ).get(questionId, source, userId);

    if (existing) {
        db.prepare(
            'UPDATE wrong_questions SET wrong_count = wrong_count + 1, correct_streak = 0, subject_id = ? WHERE id = ?'
        ).run(subjectId, existing.id);
    } else {
        db.prepare(
            'INSERT INTO wrong_questions (question_id, question_json, source, subject_id, user_id) VALUES (?, ?, ?, ?, ?)'
        ).run(questionId, questionJson, source, subjectId, userId);
    }
}

function getWrongQuestionsBySource(userId, source) {
    return db.prepare(
        'SELECT * FROM wrong_questions WHERE source = ? AND user_id = ? ORDER BY created_at DESC'
    ).all(source, userId);
}

function getWrongQuestionsBySubject(userId, subjectId) {
    return db.prepare(
        'SELECT * FROM wrong_questions WHERE subject_id = ? AND user_id = ? ORDER BY created_at DESC'
    ).all(subjectId, userId);
}

function getAllWrongQuestions(userId) {
    return db.prepare(
        'SELECT * FROM wrong_questions WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);
}

function getRandomWrongQuestions(userId, count = 10, subjectId) {
    const rows = db.prepare(
        subjectId
            ? 'SELECT * FROM wrong_questions WHERE subject_id = ? AND user_id = ? ORDER BY RANDOM() LIMIT ?'
            : 'SELECT * FROM wrong_questions WHERE user_id = ? ORDER BY RANDOM() LIMIT ?'
    ).all(subjectId, userId, count);
    return rows.map(row => ({
        ...row,
        question: JSON.parse(row.question_json)
    }));
}

function markCorrect(userId, id) {
    const row = db.prepare(
        'SELECT correct_streak FROM wrong_questions WHERE id = ? AND user_id = ?'
    ).get(id, userId);

    if (!row) return false;

    const newStreak = row.correct_streak + 1;
    if (newStreak >= 3) {
        db.prepare('DELETE FROM wrong_questions WHERE id = ? AND user_id = ?').run(id, userId);
        return true;
    }

    db.prepare(
        'UPDATE wrong_questions SET correct_streak = ? WHERE id = ? AND user_id = ?'
    ).run(newStreak, id, userId);
    return false;
}

function markWrong(userId, id) {
    db.prepare(
        'UPDATE wrong_questions SET wrong_count = wrong_count + 1, correct_streak = 0 WHERE id = ? AND user_id = ?'
    ).run(id, userId);
}

function getWrongCount(userId, subjectId) {
    const row = subjectId
        ? db.prepare('SELECT COUNT(*) as count FROM wrong_questions WHERE subject_id = ? AND user_id = ?').get(subjectId, userId)
        : db.prepare('SELECT COUNT(*) as count FROM wrong_questions WHERE user_id = ?').get(userId);
    return row.count;
}

// ─── Exam History ───

function saveExamHistory(userId, source, total, correct, score, subjectId) {
    db.prepare(
        'INSERT INTO exam_history (source, total, correct, score, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(source, total, correct, score, subjectId, userId);
}

function getProgress(userId, subjectId) {
    const history = subjectId
        ? db.prepare('SELECT * FROM exam_history WHERE subject_id = ? AND user_id = ? ORDER BY created_at ASC').all(subjectId, userId)
        : db.prepare('SELECT * FROM exam_history WHERE user_id = ? ORDER BY created_at ASC').all(userId);

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

function getWeakDomains(userId, subjectId) {
    const rows = subjectId
        ? db.prepare('SELECT question_json FROM wrong_questions WHERE subject_id = ? AND user_id = ?').all(subjectId, userId)
        : db.prepare('SELECT question_json FROM wrong_questions WHERE user_id = ?').all(userId);

    const domainMap = {};
    for (const row of rows) {
        let q;
        try { q = JSON.parse(row.question_json); } catch { continue; }
        const domain = q.domain || '未知';
        domainMap[domain] = (domainMap[domain] || 0) + 1;
    }

    const domainTotals = db.prepare(
        subjectId
            ? "SELECT domain, COUNT(*) as total FROM questions WHERE domain != '' AND subject_id = ? AND user_id = ? GROUP BY domain"
            : "SELECT domain, COUNT(*) as total FROM questions WHERE domain != '' AND user_id = ? GROUP BY domain"
    ).all(subjectId, userId);
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

// ─── Admin Functions ───

function getAllUsers() {
    return db.prepare(`
        SELECT u.id, u.email, u.is_active, u.is_disabled, u.created_at,
            (SELECT COUNT(*) FROM subjects WHERE user_id = u.id) as subject_count,
            (SELECT COUNT(*) FROM questions WHERE user_id = u.id) as question_count
        FROM users u
        WHERE u.id != 1
        ORDER BY u.id DESC
    `).all();
}

function setUserDisabled(userId, disabled) {
    db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?').run(disabled ? 1 : 0, userId);
}

function getUserSubjects(userId) {
    const subjects = db.prepare('SELECT id, name, description, quiz_count FROM subjects WHERE user_id = ? ORDER BY id').all(userId);
    return subjects.map(s => ({
        ...s,
        question_count: getSubjectQuestionCount(userId, s.id),
        wrong_count: getWrongCount(userId, s.id)
    }));
}

// ─── Backup / Restore ───

function exportUserData(userId) {
    const subjects = db.prepare('SELECT id, name, description, quiz_count FROM subjects WHERE user_id = ? ORDER BY id').all(userId);

    const subjectIdMap = {};
    for (const s of subjects) {
        subjectIdMap[s.id] = s.name;
    }

    const questions = db.prepare(
        'SELECT question_id, question_json, source, domain, type, subject_id FROM questions WHERE user_id = ?'
    ).all(userId);

    const wrongQuestions = db.prepare(
        'SELECT question_id, question_json, source, wrong_count, correct_streak, subject_id FROM wrong_questions WHERE user_id = ?'
    ).all(userId);

    const examHistory = db.prepare(
        'SELECT source, total, correct, score, subject_id FROM exam_history WHERE user_id = ?'
    ).all(userId);

    return {
        manifest: { exportedAt: new Date().toISOString(), version: 1, subjectIdMap },
        subjects,
        questions,
        wrong_questions: wrongQuestions,
        exam_history: examHistory
    };
}

function restoreUserData(userId, data) {
    const { manifest, subjects, questions, wrong_questions, exam_history } = data;
    if (!manifest || !manifest.version || !subjects) {
        throw new Error('无效的备份文件格式');
    }

    const importMany = db.transaction(() => {
        // Phase 1: Create or find subjects, build ID mapping
        const idMapping = {};
        for (const s of subjects) {
            const existing = db.prepare('SELECT id FROM subjects WHERE name = ? AND user_id = ?').get(s.name, userId);
            if (existing) {
                idMapping[s.id] = existing.id;
            } else {
                const result = db.prepare(
                    'INSERT INTO subjects (name, description, quiz_count, user_id) VALUES (?, ?, ?, ?)'
                ).run(s.name, s.description || '', s.quiz_count || 0, userId);
                idMapping[s.id] = result.lastInsertRowid;
            }
        }

        // Phase 2: Import questions
        const insertQ = db.prepare(
            'INSERT OR REPLACE INTO questions (question_id, question_json, source, domain, type, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        if (questions && questions.length > 0) {
            for (const q of questions) {
                insertQ.run(q.question_id, q.question_json, q.source, q.domain || '', q.type || '', idMapping[q.subject_id] || null, userId);
            }
        }

        // Phase 3: Import wrong questions (UPSERT)
        if (wrong_questions && wrong_questions.length > 0) {
            for (const wq of wrong_questions) {
                const existing = db.prepare(
                    'SELECT id, wrong_count FROM wrong_questions WHERE question_id = ? AND source = ? AND user_id = ?'
                ).get(wq.question_id, wq.source, userId);
                if (existing) {
                    db.prepare(
                        'UPDATE wrong_questions SET question_json = ?, subject_id = ? WHERE id = ?'
                    ).run(wq.question_json, idMapping[wq.subject_id] || null, existing.id);
                } else {
                    db.prepare(
                        'INSERT INTO wrong_questions (question_id, question_json, source, subject_id, user_id) VALUES (?, ?, ?, ?, ?)'
                    ).run(wq.question_id, wq.question_json, wq.source, idMapping[wq.subject_id] || null, userId);
                }
            }
        }

        // Phase 4: Import exam history
        const insertH = db.prepare(
            'INSERT INTO exam_history (source, total, correct, score, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?)'
        );
        if (exam_history && exam_history.length > 0) {
            for (const h of exam_history) {
                insertH.run(h.source, h.total, h.correct, h.score, idMapping[h.subject_id] || null, userId);
            }
        }
    });

    importMany();

    return {
        subjects: subjects.length,
        questions: (questions || []).length,
        wrong_questions: (wrong_questions || []).length,
        exam_history: (exam_history || []).length
    };
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
    getSubjectQuestionCount,
    // User CRUD
    createUser,
    findUserByEmail,
    findUserByToken,
    activateUser,
    getUserById,
    // Admin
    getAllUsers,
    setUserDisabled,
    getUserSubjects,
    // Backup/Restore
    exportUserData,
    restoreUserData
};
