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

// ========================
// 4. 核心：AI 对话接口（支持多模型）
// ========================
app.post('/chat', async (req, res) => {
    // 从请求中获取消息、会话ID和模型名称
    const { message, sessionId, model = 'deepseek-chat' } = req.body;

    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }

    try {
        // --- 4.1 保存用户消息到数据库 ---
        const { error: userError } = await supabase
            .from('messages')
            .insert([{ role: 'user', content: message, session_id: sessionId }]);
        if (userError) {
            console.error('❌ 保存用户消息失败:', userError.message);
        } else {
            console.log('✅ 用户消息已存入 Supabase');
        }

        // --- 4.2 根据模型选择 API 地址和 Key ---
        let apiUrl, apiKey, modelName;

        if (model === 'claude') {
            // 使用你的中转站地址和专用 Key
            apiUrl = 'https://yunwu.ai/v1/chat/completions'; // 中转站标准路径
            apiKey = 'sk-IvyaoDR2qZ2zg4iShnPAKPLPdJwx9q2txhFKX0ihUKgmHvZb'; // 你的中转站 Key
            modelName = 'claude-opus-4-6'; // 根据中转站支持的模型名调整
        } else {
            // 默认使用 DeepSeek 官方 API
            apiUrl = 'https://api.deepseek.com/v1/chat/completions';
            apiKey = process.env.DEEPSEEK_API_KEY;
            modelName = 'deepseek-chat';
        }

        // 检查 API Key 是否存在
        if (!apiKey) {
            console.error(`❌ 模型 ${model} 的 API Key 未配置`);
            return res.status(500).json({ error: `模型 ${model} 的 API Key 未配置` });
        }

        // --- 4.3 调用 AI 模型 API ---
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [
                    { role: 'system', content: '你是一个温暖的、善解人意的助手。' },
                    { role: 'user', content: message }
                ],
                stream: false
            })
        });

        // 检查 API 响应状态
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ AI API 请求失败 (${response.status}):`, errorText);
            throw new Error(`AI API 请求失败: ${response.status}`);
        }

        const data = await response.json();
        // 尝试兼容不同 API 的返回格式
        const reply = data.choices?.[0]?.message?.content || data.result || '抱歉，我没有理解。';

        // --- 4.4 保存 AI 回复到数据库 ---
        const { error: aiError } = await supabase
            .from('messages')
            .insert([{ role: 'ai', content: reply, session_id: sessionId }]);
        if (aiError) {
            console.error('❌ 保存 AI 回复失败:', aiError.message);
        } else {
            console.log('✅ AI 回复已存入 Supabase');
        }

        // --- 4.5 返回回复给前端 ---
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