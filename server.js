const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ========================
// 1. 健康检查接口
// ========================
app.get('/ping', (req, res) => {
    res.send('I am alive!');
});

// ========================
// 2. 获取某个会话的历史消息
// ========================
app.get('/messages/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });

    if (error) {
        console.error('❌ 获取历史消息失败:', error.message);
        return res.status(500).json({ error: error.message });
    }
    res.json(data);
});

// ========================
// 3. 获取所有会话列表
// ========================
app.get('/sessions', async (req, res) => {
    const { data, error } = await supabase
        .from('messages')
        .select('session_id, created_at')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('❌ 获取会话列表失败:', error.message);
        return res.status(500).json({ error: error.message });
    }

    // 去重并提取 session_id
    const sessionMap = new Map();
    data.forEach(item => {
        if (!sessionMap.has(item.session_id)) {
            sessionMap.set(item.session_id, item.created_at);
        }
    });
    const sessions = Array.from(sessionMap.entries()).map(([id, lastActive]) => ({
        id,
        lastActive
    }));
    res.json(sessions);
});
// 获取设置
app.get('/settings', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('*')
            .order('id', { ascending: true })
            .limit(1);
        if (error) throw error;
        res.json(data?.[0] || {});
    } catch (error) {
        console.error('❌ 获取设置失败:', error.message);
        res.status(500).json({ error: '获取设置失败' });
    }
});

// 更新设置
app.post('/settings', async (req, res) => {
    const { system_prompt, temperature, max_tokens } = req.body;
    try {
        const { error } = await supabase
            .from('settings')
            .update({
                system_prompt,
                temperature,
                max_tokens,
                updated_at: new Date()
            })
            .eq('id', 1);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('❌ 更新设置失败:', error.message);
        res.status(500).json({ error: '更新设置失败' });
    }
});

// ========================
// 4. 核心：AI 对话接口（支持多模型）
// ========================
app.post('/chat', async (req, res) => {
    const { message, sessionId, model = 'deepseek-chat' } = req.body;

    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }

    try {
        // --- 1. 获取设置（优先使用前端传来的，否则从数据库读取） ---
let systemPrompt, temperature, maxTokens;
if (req.body.system_prompt && req.body.temperature !== undefined) {
    // 前端传了设置，直接使用
    systemPrompt = req.body.system_prompt;
    temperature = req.body.temperature;
    maxTokens = req.body.max_tokens || 2048;
} else {
    // 前端没传，从数据库读取
    const { data: settingsData } = await supabase
        .from('settings')
        .select('system_prompt, temperature, max_tokens')
        .order('id', { ascending: true })
        .limit(1);
    const settings = settingsData?.[0] || {
        system_prompt: '你是一个温暖的、善解人意的助手。',
        temperature: 0.7,
        max_tokens: 2048
    };
    systemPrompt = settings.system_prompt;
    temperature = settings.temperature;
    maxTokens = settings.max_tokens;
}
        // --- 1.5 拉取最近的历史消息（用于上下文） ---
const { data: historyData } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(20); // 取最近20条消息（约10轮对话）

// 构建历史消息数组（将数据库中的 'ai' 转换为 API 需要的 'assistant'）
const historyMessages = historyData ? historyData.map(msg => ({
    role: msg.role === 'ai' ? 'assistant' : msg.role,
    content: msg.content
})) : [];

        // --- 2. 保存用户消息到 Supabase ---
        const { error: userError } = await supabase
            .from('messages')
            .insert([{ role: 'user', content: message, session_id: sessionId }]);
        if (userError) {
            console.error('❌ 保存用户消息失败:', userError.message);
        } else {
            console.log('✅ 用户消息已存入 Supabase');
        }

        // --- 3. 根据模型选择 API 地址和 Key ---
        let apiUrl, apiKey, modelName;
        if (model === 'claude') {
            apiUrl = 'https://yunwu.ai/v1/chat/completions';
            apiKey = process.env.CLAUDE_API_KEY;
            modelName = 'claude-opus-4-6';
        } else if (model === 'gemini') {
            apiUrl = 'https://yunwu.ai/v1/chat/completions';
            apiKey = process.env.GEMINI_API_KEY;
            modelName = 'gemini-3.1-flash-lite';
        } else {
            apiUrl = 'https://api.deepseek.com/v1/chat/completions';
            apiKey = process.env.DEEPSEEK_API_KEY;
            modelName = 'deepseek-chat';
        }

        if (!apiKey) {
            console.error(`❌ 模型 ${model} 的 API Key 未配置`);
            return res.status(500).json({ error: `模型 ${model} 的 API Key 未配置` });
        }

        // --- 4. 调用 AI API（使用从数据库读取的 settings） ---
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [
                  { role: 'system', content: systemPrompt },
                ...historyMessages,  // 展开历史消息
                  { role: 'user', content: message }  // 当前消息放在最后
        ],
        stream: false,
        temperature: temperature,
        max_tokens: maxTokens
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ AI API 请求失败 (${response.status}):`, errorText);
            throw new Error(`AI API 请求失败: ${response.status}`);
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || data.result || '抱歉，我没有理解。';

        // --- 5. 保存 AI 回复到 Supabase ---
        const { error: aiError } = await supabase
            .from('messages')
            .insert([{ role: 'ai', content: reply, session_id: sessionId }]);
        if (aiError) {
            console.error('❌ 保存 AI 回复失败:', aiError.message);
        } else {
            console.log('✅ AI 回复已存入 Supabase');
        }

        res.json({ reply });

    } catch (error) {
        console.error('❌ 请求处理失败:', error.message);
        res.status(500).json({ error: 'AI 服务暂时不可用，请稍后再试。' });
    }
});

// ========================
// 5. 启动服务器
// ========================
app.listen(PORT, () => {
    console.log(`✅ 服务已启动，端口: ${PORT}`);
});
