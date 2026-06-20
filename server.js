const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(express.json());

app.get('/ping', (req, res) => {
    res.send('I am alive!');
});

app.post('/chat', async (req, res) => {
    // 获取某个会话的历史消息
app.get('/messages/:sessionId', async (req, res) => {
    // 获取所有会话列表（按最后活动时间排序）
app.get('/sessions', async (req, res) => {
    const { data, error } = await supabase
        .from('messages')
        .select('session_id, created_at')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('❌ 获取会话列表失败:', error.message);
        return res.status(500).json({ error: error.message });
    }

    // 去重并提取 session_id，保留最新时间
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
    const { message, sessionId } = req.body;

    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: '服务器未配置 API Key' });
    }

    try {
        // 保存用户消息到 Supabase（带 session_id）
        const { error: userError } = await supabase
            .from('messages')
            .insert([{ role: 'user', content: message, session_id: sessionId }]);
        if (userError) {
            console.error('❌ 保存用户消息失败:', userError.message);
        } else {
            console.log('✅ 用户消息已存入 Supabase');
        }

        // 调用 DeepSeek API
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: '你是一个温暖的、善解人意的助手。' },
                    { role: 'user', content: message }
                ],
                stream: false
            })
        });

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '抱歉，我没有理解。';

        // 保存 AI 回复到 Supabase（带 session_id）
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
        res.status(500).json({ error: 'AI 服务暂时不可用' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ 服务已启动，端口: ${PORT}`);
});
 // test