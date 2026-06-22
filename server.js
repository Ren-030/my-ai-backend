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
// 获取所有会话列表（含会话名称）
app.get('/sessions', async (req, res) => {
    const { data, error } = await supabase
        .from('messages')
        .select('session_id, session_name, created_at')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('❌ 获取会话列表失败:', error.message);
        return res.status(500).json({ error: error.message });
    }

    // 去重并提取 session_id，保留最新的 session_name
    const sessionMap = new Map();
    data.forEach(item => {
        if (!sessionMap.has(item.session_id)) {
            sessionMap.set(item.session_id, {
                id: item.session_id,
                session_name: item.session_name,
                lastActive: item.created_at
            });
        }
    });
    const sessions = Array.from(sessionMap.values());
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

// 重命名会话
app.put('/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { session_name } = req.body;

    if (!session_name || session_name.trim() === '') {
        return res.status(400).json({ error: '会话名称不能为空' });
    }

    const { error } = await supabase
        .from('messages')
        .update({ session_name: session_name.trim() })
        .eq('session_id', sessionId);

    if (error) {
        console.error('❌ 重命名会话失败:', error.message);
        return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
});

// 删除会话（删除该会话下的所有消息）
app.delete('/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    const { error } = await supabase
        .from('messages')
        .delete()
        .eq('session_id', sessionId);

    if (error) {
        console.error('❌ 删除会话失败:', error.message);
        return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
});

// ---------- 上下文压缩工具函数 ----------

// 1. 生成摘要（调用 DeepSeek）
const generateSummary = async (messages) => {
    const conversationText = messages.map(m => 
        `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`
    ).join('\n');

    const prompt = `
请将以下对话压缩成一段300-500字的摘要，包含以下四个部分：

【用户信息】
【重要事实】
【当前任务】
【未完成事项】

对话内容：
${conversationText}
`;

    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            stream: false
        })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
};

// 2. 执行压缩（取前8条 → 生成摘要 → 存表 → 删除原消息）
const compressSession = async (sessionId) => {
    // 2.1 取前 8 条消息（按时间升序）
    const { data: oldMessages, error: fetchError } = await supabase
        .from('messages')
        .select('id, role, content')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(8);

    if (fetchError || !oldMessages || oldMessages.length === 0) {
        console.log('⚠️ 没有可压缩的消息');
        return;
    }

    // 2.2 生成摘要
    console.log(`📝 正在压缩 ${oldMessages.length} 条消息...`);
    const summary = await generateSummary(oldMessages);

    // 2.3 存入 summaries 表
    const { error: insertError } = await supabase
        .from('summaries')
        .insert([{ session_id: sessionId, summary }]);

    if (insertError) {
        console.error('❌ 存储摘要失败:', insertError);
        return;
    }

    // 2.4 删除被压缩的原始消息
    const idsToDelete = oldMessages.map(m => m.id);
    const { error: deleteError } = await supabase
        .from('messages')
        .delete()
        .in('id', idsToDelete);

    if (deleteError) {
        console.error('❌ 删除原始消息失败:', deleteError);
        return;
    }

    console.log(`✅ 压缩完成，已删除 ${idsToDelete.length} 条消息，摘要已保存`);
};

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
    // --- 1.5 上下文压缩与近期消息拉取 ---

// 1. 检查当前会话的消息总数，判断是否需要压缩
const { count, error: countError } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId);

if (countError) {
    console.error('❌ 获取消息计数失败:', countError);
} else if (count > 12) {
    console.log(`📊 当前消息数 ${count}，超过 12 条，触发压缩...`);
    await compressSession(sessionId);
}

// 2. 拉取最新的摘要（如果有）
const { data: summaryData } = await supabase
    .from('summaries')
    .select('summary')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1);

const summary = summaryData?.[0]?.summary || '';

// 3. 拉取近期消息（只拉最近 4 条，因为更早的已被压缩或即将被压缩）
const { data: recentMessages } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(4);

// 4. 组装上下文
// 注意：我们不再需要 `historyData` 了，直接用 summary + recentMessages 构造 messages 数组
// 但 messages 数组的构造会在原有代码中靠后的位置进行，所以这里只负责获取数据。
// 不过为了减少混淆，我们可以把原有的 messages 构造逻辑也一并替换。

// 实际上，你原本代码里在调用 AI API 时，会使用一个 `messages` 变量。
// 我们现在就用新的数据来构造它。
const chatMessages = [
    { role: 'system', content: systemPrompt },
];

if (summary) {
    chatMessages.push({ role: 'system', content: `【历史摘要】\n${summary}` });
}

// 添加近期消息（注意转换 role）
(recentMessages || []).forEach(msg => {
    chatMessages.push({
        role: msg.role === 'ai' ? 'assistant' : msg.role,
        content: msg.content
    });
});

// 添加当前用户消息
chatMessages.push({ role: 'user', content: message });

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
                messages: chatMessages,  // 直接使用我们构造好的数组
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
