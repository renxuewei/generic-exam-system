const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Load .env file (simple parser, no dependency needed)
 */
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }
    return env;
}

/**
 * Call AI API (OpenAI-compatible) with streaming disabled for full response
 */
function callAI(env, userMessage) {
    return new Promise((resolve, reject) => {
        const apiKey = env.AI_API_KEY;
        const baseUrl = env.AI_BASE_URL;
        const model = env.AI_MODEL;

        if (!apiKey || !baseUrl || !model) {
            return reject(new Error('.env 缺少配置，请确保包含 AI_API_KEY, AI_BASE_URL, AI_MODEL'));
        }

        const url = new URL(baseUrl + '/chat/completions');
        const isHttps = url.protocol === 'https:';
        const transport = isHttps ? https : http;

        const body = JSON.stringify({
            model,
            messages: [
                { role: 'user', content: userMessage }
            ],
            temperature: 0.8,
            stream: false
        });

        const req = transport.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`API 返回 ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.message?.content;
                    if (!content) {
                        reject(new Error('API 响应中没有 content'));
                    }
                    else {
                        resolve(content);
                    }
                } catch (e) {
                    reject(new Error('解析 API 响应失败: ' + e.message));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(120000, () => {
            req.destroy();
            reject(new Error('请求超时 (120s)'));
        });
        req.write(body);
        req.end();
    });
}

/**
 * Extract JSON array from AI response (may be wrapped in ```json ... ```)
 */
function extractJSON(text) {
    const codeMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeMatch) {
        try {
            const arr = new Function('return (' + codeMatch[1].trim() + ')')();
            if (Array.isArray(arr)) return arr;
        } catch { }
    }
    try {
        const arr = new Function('return (' + text.trim() + ')')();
        if (Array.isArray(arr)) return arr;
    } catch { }
    try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) return arr;
    } catch { }
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
        try {
            const arr = new Function('return (' + text.slice(start, end + 1) + ')')();
            if (Array.isArray(arr)) return arr;
        } catch { }
    }
    throw new Error('无法从 AI 响应中提取 JSON 数组');
}

/**
 * Build prompt from template + subject info
 */
function buildPrompt(subjectName, subjectDescription, questionCount = 65) {
    const promptPath = path.join(__dirname, 'prompt.txt');
    let template;
    if (fs.existsSync(promptPath)) {
        template = fs.readFileSync(promptPath, 'utf-8').trim();
    } else {
        template = `不要使用缓存，全新生成一份包含了 {question_count} 道题的 {subject_name} 模拟题数据包（JSON格式）。
学科说明：{subject_description}
为了保证响应不被系统截断，将试题以精炼但信息丰富的形式呈现，多选题要占到至少8%-10%。
这是输出的JSON格式供你参考：
[
  { id: 1, type: "single", domain: "领域名", question: "题目内容", options: { A: "选项A", B: "选项B", C: "选项C", D: "选项D" }, correct: ["B"], explanation: "解析说明" },
  { id: 2, type: "multiple", domain: "领域名", question: "题目内容(选两项)", options: { A: "选项A", B: "选项B", C: "选项C", D: "选项D", E: "选项E" }, correct: ["B", "E"], explanation: "解析说明" }
]`;
    }

    return template
        .replace(/\{subject_name\}/g, subjectName)
        .replace(/\{subject_description\}/g, subjectDescription)
        .replace(/\{question_count\}/g, String(questionCount));
}

/**
 * Generate quiz questions via AI and return the array
 * @param {string} subjectName - Subject name
 * @param {string} subjectDescription - Subject description
 * @param {number} questionCount - Number of questions to generate
 */
async function generateQuiz(subjectName, subjectDescription, questionCount = 65) {
    const env = loadEnv();

    const prompt = buildPrompt(subjectName, subjectDescription, questionCount);

    console.log(`模型: ${env.AI_MODEL}`);
    console.log(`API:  ${env.AI_BASE_URL}`);
    console.log('正在调用 AI 生成试题，请耐心等待...\n');

    const response = await callAI(env, prompt);
    const quizData = extractJSON(response);

    if (!Array.isArray(quizData) || quizData.length === 0) {
        throw new Error('AI 返回的数据为空或格式不正确');
    }

    // Normalize
    for (let i = 0; i < quizData.length; i++) {
        const q = quizData[i];
        if (!q.id) q.id = i + 1;
        if (!q.type) q.type = 'single';
        if (!q.domain) q.domain = '综合';
        if (!Array.isArray(q.correct)) q.correct = [q.correct];
    }

    return quizData;
}

module.exports = { generateQuiz, loadEnv, buildPrompt };
