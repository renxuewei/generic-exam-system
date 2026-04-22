const { createClient } = require('@libsql/client');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const INPUTS_DIR = path.join(__dirname, 'inputs');
let db;

/**
 * Synchronously create the libSQL client.
 * Uses TURSO_DATABASE_URL for cloud, falls back to local file.
 */
function createDbClient() {
    const url = process.env.TURSO_DATABASE_URL;
    if (url) {
        db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
    } else {
        db = createClient({ url: 'file:' + path.join(__dirname, 'quiz.db') });
    }
}

/**
 * Async initialization: create tables and run migrations
 */
async function initDB() {
    try {
        await db.batch([
            { sql: 'CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)' },
            { sql: `CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_active INTEGER DEFAULT 0,
                activation_token TEXT,
                activation_expires_at TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            )` },
            { sql: `CREATE TABLE IF NOT EXISTS subjects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                quiz_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            )` },
            { sql: `CREATE TABLE IF NOT EXISTS questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id TEXT NOT NULL,
                question_json TEXT NOT NULL,
                source TEXT NOT NULL,
                domain TEXT,
                type TEXT,
                subject_id INTEGER REFERENCES subjects(id)
            )` },
            { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_qid_source ON questions(question_id, source)' },
            { sql: `CREATE TABLE IF NOT EXISTS wrong_questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id TEXT NOT NULL,
                question_json TEXT NOT NULL,
                source TEXT NOT NULL,
                wrong_count INTEGER DEFAULT 1,
                correct_streak INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                subject_id INTEGER REFERENCES subjects(id)
            )` },
            { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_wq_source ON wrong_questions(question_id, source)' },
            { sql: `CREATE TABLE IF NOT EXISTS exam_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                total INTEGER NOT NULL,
                correct INTEGER NOT NULL,
                score REAL NOT NULL,
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                subject_id INTEGER REFERENCES subjects(id)
            )` },
            { sql: `CREATE TABLE IF NOT EXISTS sessions (
                sid TEXT PRIMARY KEY,
                expired INTEGER NOT NULL,
                sess TEXT NOT NULL
            )` },
        ]);

        await runMigration();
    } catch (err) {
        console.error('Failed to create database tables:', err.message);
        throw new Error(`Database schema creation failed: ${err.message}`);
    }
}

/**
 * Run schema migration to add user_id columns and indexes
 */
async function runMigration() {
    // Insert migration user (id=1) to preserve foreign key integrity
    await db.execute(
        `INSERT OR IGNORE INTO users (id, email, password_hash, is_active, activation_token, created_at)
         VALUES (1, 'migrated@system', 'no-login', 1, NULL, datetime('now', 'localtime'))`
    );

    // Add user_id to subjects
    if (!(await columnExists('subjects', 'user_id'))) {
        await db.execute('ALTER TABLE subjects ADD COLUMN user_id INTEGER DEFAULT 1');
    }
    // Add user_id to questions
    if (!(await columnExists('questions', 'user_id'))) {
        await db.execute('ALTER TABLE questions ADD COLUMN user_id INTEGER DEFAULT 1');
    }
    // Add user_id to wrong_questions
    if (!(await columnExists('wrong_questions', 'user_id'))) {
        await db.execute('ALTER TABLE wrong_questions ADD COLUMN user_id INTEGER DEFAULT 1');
    }
    // Add user_id to exam_history
    if (!(await columnExists('exam_history', 'user_id'))) {
        await db.execute('ALTER TABLE exam_history ADD COLUMN user_id INTEGER DEFAULT 1');
    }

    // Add is_disabled to users
    if (!(await columnExists('users', 'is_disabled'))) {
        await db.execute('ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0');
    }

    // Add reset_token columns for password reset
    if (!(await columnExists('users', 'reset_token'))) {
        await db.execute('ALTER TABLE users ADD COLUMN reset_token TEXT');
    }
    if (!(await columnExists('users', 'reset_expires_at'))) {
        await db.execute('ALTER TABLE users ADD COLUMN reset_expires_at TEXT');
    }

    // Recreate composite indexes with user_id
    await db.batch([
        { sql: 'DROP INDEX IF EXISTS idx_qid_source' },
        { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_qid_source_user ON questions(question_id, source, user_id)' },
        { sql: 'DROP INDEX IF EXISTS idx_wq_source' },
        { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_wq_source_user ON wrong_questions(question_id, source, user_id)' },
        { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_subject_user_name ON subjects(user_id, name)' },
    ]);
}

/**
 * Check if a column exists in a table
 */
async function columnExists(tableName, columnName) {
    const result = await db.execute(`SELECT count(*) as cnt FROM pragma_table_info('${tableName}') WHERE name = '${columnName}'`);
    return result.rows[0].cnt > 0;
}

// ─── User CRUD ───

async function createUser(email, passwordHash, token, expiresAt) {
    const result = await db.execute(
        'INSERT INTO users (email, password_hash, activation_token, activation_expires_at) VALUES (?, ?, ?, ?)',
        [email, passwordHash, token, expiresAt]
    );
    return Number(result.lastInsertRowid);
}

async function findUserByEmail(email) {
    const result = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    return result.rows[0] || null;
}

async function findUserByToken(token) {
    const result = await db.execute('SELECT * FROM users WHERE activation_token = ?', [token]);
    return result.rows[0] || null;
}

async function activateUser(userId) {
    await db.execute(
        'UPDATE users SET is_active = 1, activation_token = NULL, activation_expires_at = NULL WHERE id = ?',
        [userId]
    );
}

async function getUserById(id) {
    const result = await db.execute('SELECT id, email, is_active, created_at FROM users WHERE id = ?', [id]);
    return result.rows[0] || null;
}

// ─── Subject CRUD ───

async function createSubject(userId, name, description = '') {
    const result = await db.execute(
        'INSERT INTO subjects (name, description, user_id) VALUES (?, ?, ?)',
        [name, description, userId]
    );
    return Number(result.lastInsertRowid);
}

async function getSubjects(userId) {
    const result = await db.execute('SELECT * FROM subjects WHERE user_id = ? ORDER BY id', [userId]);
    return result.rows;
}

async function getSubjectById(userId, id) {
    const result = await db.execute('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [id, userId]);
    return result.rows[0] || null;
}

async function updateSubject(userId, id, name, description, quizCount) {
    if (name !== undefined) {
        await db.execute('UPDATE subjects SET name = ? WHERE id = ? AND user_id = ?', [name, id, userId]);
    }
    if (description !== undefined) {
        await db.execute('UPDATE subjects SET description = ? WHERE id = ? AND user_id = ?', [description, id, userId]);
    }
    if (quizCount !== undefined) {
        await db.execute('UPDATE subjects SET quiz_count = ? WHERE id = ? AND user_id = ?', [quizCount, id, userId]);
    }
}

async function deleteSubject(userId, id) {
    await db.execute('DELETE FROM exam_history WHERE subject_id = ? AND user_id = ?', [id, userId]);
    await db.execute('DELETE FROM wrong_questions WHERE subject_id = ? AND user_id = ?', [id, userId]);
    await db.execute('DELETE FROM questions WHERE subject_id = ? AND user_id = ?', [id, userId]);
    await db.execute('DELETE FROM subjects WHERE id = ? AND user_id = ?', [id, userId]);
}

async function getSubjectQuestionCount(userId, subjectId) {
    const result = await db.execute(
        'SELECT COUNT(*) as count FROM questions WHERE subject_id = ? AND user_id = ?',
        [subjectId, userId]
    );
    return result.rows[0].count;
}

// ─── Questions ───

async function getQuestionsBySubject(userId, subjectId) {
    const result = await db.execute(
        'SELECT * FROM questions WHERE subject_id = ? AND user_id = ? ORDER BY id',
        [subjectId, userId]
    );
    return result.rows.map(r => JSON.parse(r.question_json));
}

/**
 * Get random N questions for a subject. If count is 0, return all.
 */
async function getRandomQuestions(userId, subjectId, count) {
    if (!count || count <= 0) return getQuestionsBySubject(userId, subjectId);
    const result = await db.execute(
        'SELECT * FROM questions WHERE subject_id = ? AND user_id = ? ORDER BY RANDOM() LIMIT ?',
        [subjectId, userId, count]
    );
    return result.rows.map(r => JSON.parse(r.question_json));
}

/**
 * Insert questions for a subject (transaction)
 */
async function insertQuestions(userId, subjectId, quizData, source) {
    const rows = quizData.map(q => [
        String(q.id),
        JSON.stringify(q),
        source,
        q.domain || '',
        q.type || 'single',
        subjectId,
        userId
    ]);

    await db.execute('BEGIN');
    try {
        for (const row of rows) {
            await db.execute(
                'INSERT OR REPLACE INTO questions (question_id, question_json, source, domain, type, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                row
            );
        }
        await db.execute('COMMIT');
    } catch (e) {
        await db.execute('ROLLBACK');
        throw e;
    }
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
async function importErrorsFromFiles(userId) {
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
        const subjectResult = await db.execute('SELECT id FROM subjects WHERE name = ? AND user_id = ?', [source, userId]);
        const subjectId = subjectResult.rows[0] ? subjectResult.rows[0].id : null;

        const errors = parseErrorsFile(path.join(INPUTS_DIR, file));
        let imported = 0;

        for (const err of errors) {
            const qIndex = err.questionIndex - 1;
            if (qIndex < 0 || qIndex >= quizData.length) continue;

            const question = quizData[qIndex];
            if (question.question !== err.questionText) {
                const matched = quizData.find(q => q.id === question.id);
                if (matched) {
                    await upsertWrongQuestion(userId, String(matched.id), JSON.stringify(matched), source, subjectId);
                    imported++;
                }
                continue;
            }

            await upsertWrongQuestion(userId, String(question.id), JSON.stringify(question), source, subjectId);
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
async function importAllQuizData(userId) {
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
        const subjectResult = await db.execute('SELECT id FROM subjects WHERE name = ? AND user_id = ?', [source, userId]);
        const subjectId = subjectResult.rows[0] ? subjectResult.rows[0].id : null;

        await db.execute('BEGIN');
        try {
            for (const q of quizData) {
                await db.execute(
                    'INSERT OR REPLACE INTO questions (question_id, question_json, source, domain, type, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [String(q.id), JSON.stringify(q), source, q.domain || '', q.type || 'single', subjectId, userId]
                );
            }
            await db.execute('COMMIT');
            console.log(`  ${file}: ${quizData.length} 道试题已导入`);
            totalImported += quizData.length;
        } catch (e) {
            await db.execute('ROLLBACK');
            throw e;
        }
    }
    return totalImported;
}

/**
 * Import quiz data from a JSON file into the questions table.
 */
async function importQuizFromJSON(userId, filePath, source, subjectId) {
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
async function getSources(userId, subjectId) {
    let result;
    if (subjectId) {
        result = await db.execute(
            'SELECT source, COUNT(*) as count FROM questions WHERE subject_id = ? AND user_id = ? GROUP BY source ORDER BY source',
            [subjectId, userId]
        );
    } else {
        result = await db.execute(
            'SELECT source, COUNT(*) as count FROM questions WHERE user_id = ? GROUP BY source ORDER BY source',
            [userId]
        );
    }
    return result.rows;
}

/**
 * Full initialization: create client + tables
 */
async function initialize() {
    await initDB();
    return db;
}

function getClient() {
    return db;
}

function getDB() {
    return db;
}

// ─── Wrong Questions ───

async function upsertWrongQuestion(userId, questionId, questionJson, source, subjectId) {
    const existing = await db.execute(
        'SELECT id, wrong_count FROM wrong_questions WHERE question_id = ? AND source = ? AND user_id = ?',
        [questionId, source, userId]
    );

    if (existing.rows.length > 0) {
        await db.execute(
            'UPDATE wrong_questions SET wrong_count = wrong_count + 1, correct_streak = 0, subject_id = ? WHERE id = ?',
            [subjectId, existing.rows[0].id]
        );
    } else {
        await db.execute(
            'INSERT INTO wrong_questions (question_id, question_json, source, subject_id, user_id) VALUES (?, ?, ?, ?, ?)',
            [questionId, questionJson, source, subjectId, userId]
        );
    }
}

async function getWrongQuestionsBySource(userId, source) {
    const result = await db.execute(
        'SELECT * FROM wrong_questions WHERE source = ? AND user_id = ? ORDER BY created_at DESC',
        [source, userId]
    );
    return result.rows;
}

async function getWrongQuestionsBySubject(userId, subjectId) {
    const result = await db.execute(
        'SELECT * FROM wrong_questions WHERE subject_id = ? AND user_id = ? ORDER BY created_at DESC',
        [subjectId, userId]
    );
    return result.rows;
}

async function getAllWrongQuestions(userId) {
    const result = await db.execute(
        'SELECT * FROM wrong_questions WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
    );
    return result.rows;
}

async function getRandomWrongQuestions(userId, count = 10, subjectId) {
    let result;
    if (subjectId) {
        result = await db.execute(
            'SELECT * FROM wrong_questions WHERE subject_id = ? AND user_id = ? ORDER BY RANDOM() LIMIT ?',
            [subjectId, userId, count]
        );
    } else {
        result = await db.execute(
            'SELECT * FROM wrong_questions WHERE user_id = ? ORDER BY RANDOM() LIMIT ?',
            [userId, count]
        );
    }
    return result.rows.map(row => ({
        ...row,
        question: JSON.parse(row.question_json)
    }));
}

async function markCorrect(userId, id) {
    const result = await db.execute(
        'SELECT correct_streak FROM wrong_questions WHERE id = ? AND user_id = ?',
        [id, userId]
    );

    if (!result.rows.length) return false;

    const newStreak = result.rows[0].correct_streak + 1;
    if (newStreak >= 3) {
        await db.execute('DELETE FROM wrong_questions WHERE id = ? AND user_id = ?', [id, userId]);
        return true;
    }

    await db.execute(
        'UPDATE wrong_questions SET correct_streak = ? WHERE id = ? AND user_id = ?',
        [newStreak, id, userId]
    );
    return false;
}

async function markWrong(userId, id) {
    await db.execute(
        'UPDATE wrong_questions SET wrong_count = wrong_count + 1, correct_streak = 0 WHERE id = ? AND user_id = ?',
        [id, userId]
    );
}

async function getWrongCount(userId, subjectId) {
    let result;
    if (subjectId) {
        result = await db.execute(
            'SELECT COUNT(*) as count FROM wrong_questions WHERE subject_id = ? AND user_id = ?',
            [subjectId, userId]
        );
    } else {
        result = await db.execute(
            'SELECT COUNT(*) as count FROM wrong_questions WHERE user_id = ?',
            [userId]
        );
    }
    return result.rows[0].count;
}

// ─── Exam History ───

async function saveExamHistory(userId, source, total, correct, score, subjectId) {
    await db.execute(
        'INSERT INTO exam_history (source, total, correct, score, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?)',
        [source, total, correct, score, subjectId, userId]
    );
}

async function getProgress(userId, subjectId) {
    let result;
    if (subjectId) {
        result = await db.execute(
            'SELECT * FROM exam_history WHERE subject_id = ? AND user_id = ? ORDER BY created_at ASC',
            [subjectId, userId]
        );
    } else {
        result = await db.execute(
            'SELECT * FROM exam_history WHERE user_id = ? ORDER BY created_at ASC',
            [userId]
        );
    }
    const history = result.rows;

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

async function getWeakDomains(userId, subjectId) {
    let wqResult;
    if (subjectId) {
        wqResult = await db.execute(
            'SELECT question_json FROM wrong_questions WHERE subject_id = ? AND user_id = ?',
            [subjectId, userId]
        );
    } else {
        wqResult = await db.execute(
            'SELECT question_json FROM wrong_questions WHERE user_id = ?',
            [userId]
        );
    }

    const domainMap = {};
    for (const row of wqResult.rows) {
        let q;
        try { q = JSON.parse(row.question_json); } catch { continue; }
        const domain = q.domain || '未知';
        domainMap[domain] = (domainMap[domain] || 0) + 1;
    }

    let domainTotalsResult;
    if (subjectId) {
        domainTotalsResult = await db.execute(
            "SELECT domain, COUNT(*) as total FROM questions WHERE domain != '' AND subject_id = ? AND user_id = ? GROUP BY domain",
            [subjectId, userId]
        );
    } else {
        domainTotalsResult = await db.execute(
            "SELECT domain, COUNT(*) as total FROM questions WHERE domain != '' AND user_id = ? GROUP BY domain",
            [userId]
        );
    }
    const totalMap = {};
    for (const d of domainTotalsResult.rows) {
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

// ─── Password Reset ───

async function createPasswordResetToken(email) {
    const user = await findUserByEmail(email);
    if (!user) return null;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
    await db.execute(
        'UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?',
        [token, expiresAt, user.id]
    );
    return token;
}

async function findUserByResetToken(token) {
    const result = await db.execute('SELECT * FROM users WHERE reset_token = ?', [token]);
    return result.rows[0] || null;
}

async function resetPassword(userId, passwordHash) {
    await db.execute(
        'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?',
        [passwordHash, userId]
    );
}

// ─── Admin Functions ───

async function getAllUsers() {
    const result = await db.execute(`
        SELECT u.id, u.email, u.is_active, u.is_disabled, u.created_at,
            (SELECT COUNT(*) FROM subjects WHERE user_id = u.id) as subject_count,
            (SELECT COUNT(*) FROM questions WHERE user_id = u.id) as question_count
        FROM users u
        WHERE u.id != 1
        ORDER BY u.id DESC
    `);
    return result.rows;
}

async function setUserDisabled(userId, disabled) {
    await db.execute('UPDATE users SET is_disabled = ? WHERE id = ?', [disabled ? 1 : 0, userId]);
}

async function getUserSubjects(userId) {
    const subjectsResult = await db.execute(
        'SELECT id, name, description, quiz_count FROM subjects WHERE user_id = ? ORDER BY id',
        [userId]
    );
    const subjects = subjectsResult.rows;
    const result = [];
    for (const s of subjects) {
        const questionCount = await getSubjectQuestionCount(userId, s.id);
        const wrongCount = await getWrongCount(userId, s.id);
        result.push({ ...s, question_count: questionCount, wrong_count: wrongCount });
    }
    return result;
}

// ─── Backup / Restore ───

async function exportUserData(userId) {
    const subjectsResult = await db.execute(
        'SELECT id, name, description, quiz_count FROM subjects WHERE user_id = ? ORDER BY id',
        [userId]
    );
    const subjects = subjectsResult.rows;

    const subjectIdMap = {};
    for (const s of subjects) {
        subjectIdMap[s.id] = s.name;
    }

    const questions = (await db.execute(
        'SELECT question_id, question_json, source, domain, type, subject_id FROM questions WHERE user_id = ?',
        [userId]
    )).rows;

    const wrongQuestions = (await db.execute(
        'SELECT question_id, question_json, source, wrong_count, correct_streak, subject_id FROM wrong_questions WHERE user_id = ?',
        [userId]
    )).rows;

    const examHistory = (await db.execute(
        'SELECT source, total, correct, score, subject_id FROM exam_history WHERE user_id = ?',
        [userId]
    )).rows;

    return {
        manifest: { exportedAt: new Date().toISOString(), version: 1, subjectIdMap },
        subjects,
        questions,
        wrong_questions: wrongQuestions,
        exam_history: examHistory
    };
}

async function restoreUserData(userId, data) {
    const { manifest, subjects, questions, wrong_questions, exam_history } = data;
    if (!manifest || !manifest.version || !subjects) {
        throw new Error('无效的备份文件格式');
    }

    await db.execute('BEGIN');
    try {
        // Phase 1: Create or find subjects, build ID mapping
        const idMapping = {};
        for (const s of subjects) {
            const existing = await db.execute(
                'SELECT id FROM subjects WHERE name = ? AND user_id = ?', [s.name, userId]
            );
            if (existing.rows.length > 0) {
                idMapping[s.id] = existing.rows[0].id;
            } else {
                const result = await db.execute(
                    'INSERT INTO subjects (name, description, quiz_count, user_id) VALUES (?, ?, ?, ?)',
                    [s.name, s.description || '', s.quiz_count || 0, userId]
                );
                idMapping[s.id] = Number(result.lastInsertRowid);
            }
        }

        // Phase 2: Import questions
        if (questions && questions.length > 0) {
            for (const q of questions) {
                await db.execute(
                    'INSERT OR REPLACE INTO questions (question_id, question_json, source, domain, type, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [q.question_id, q.question_json, q.source, q.domain || '', q.type || '', idMapping[q.subject_id] || null, userId]
                );
            }
        }

        // Phase 3: Import wrong questions (UPSERT)
        if (wrong_questions && wrong_questions.length > 0) {
            for (const wq of wrong_questions) {
                const existing = await db.execute(
                    'SELECT id, wrong_count FROM wrong_questions WHERE question_id = ? AND source = ? AND user_id = ?',
                    [wq.question_id, wq.source, userId]
                );
                if (existing.rows.length > 0) {
                    await db.execute(
                        'UPDATE wrong_questions SET question_json = ?, subject_id = ? WHERE id = ?',
                        [wq.question_json, idMapping[wq.subject_id] || null, existing.rows[0].id]
                    );
                } else {
                    await db.execute(
                        'INSERT INTO wrong_questions (question_id, question_json, source, subject_id, user_id) VALUES (?, ?, ?, ?, ?)',
                        [wq.question_id, wq.question_json, wq.source, idMapping[wq.subject_id] || null, userId]
                    );
                }
            }
        }

        // Phase 4: Import exam history
        if (exam_history && exam_history.length > 0) {
            for (const h of exam_history) {
                await db.execute(
                    'INSERT INTO exam_history (source, total, correct, score, subject_id, user_id) VALUES (?, ?, ?, ?, ?, ?)',
                    [h.source, h.total, h.correct, h.score, idMapping[h.subject_id] || null, userId]
                );
            }
        }

        await db.execute('COMMIT');
    } catch (e) {
        await db.execute('ROLLBACK');
        throw e;
    }

    return {
        subjects: subjects.length,
        questions: (questions || []).length,
        wrong_questions: (wrong_questions || []).length,
        exam_history: (exam_history || []).length
    };
}

module.exports = {
    createDbClient,
    initialize,
    getDB,
    getClient,
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
    // Password Reset
    createPasswordResetToken,
    findUserByResetToken,
    resetPassword,
    // Admin
    getAllUsers,
    setUserDisabled,
    getUserSubjects,
    // Backup/Restore
    exportUserData,
    restoreUserData
};
