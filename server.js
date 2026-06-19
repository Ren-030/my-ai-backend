const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(cors()); // 允许所有来源访问
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
const PORT = process.env.PORT || 3000;

// 允许接收 JSON 格式的数据
app.use(express.json());

// 健康检查（你刚才验证过的）
app.get('/ping', (req, res) => {
    res.send('I am alive!');
});

// 核心：AI 对话接口
app.post('/chat', async (req, res) => {
    const { message } = req.body;

    // 验证请求
    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }

    // 从环境变量获取 API Key（Zeabur 上配置）
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: '服务器未配置 API Key' });
    }

    try {
     // 保存用户消息到 Supabase
await supabase.from('messages').insert([{ role: 'user', content: message }]);   
        // 调用 DeepSeek API
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',  // 使用 DeepSeek 的对话模型
                messages: [
                    { role: 'system', content: '你是一个温暖的、善解人意的助手。' },
                    { role: 'user', content: message }
                ],
                stream: false
            })
        });

        const data = await response.json();

        // 提取 AI 的回复内容
        const reply = data.choices?.[0]?.message?.content || '抱歉，我没有理解。';
        // 保存 AI 回复到 Supabase
await supabase.from('messages').insert([{ role: 'ai', content: reply }]);

        res.json({ reply });

    } catch (error) {
        console.error('DeepSeek API 调用失败:', error);
        res.status(500).json({ error: 'AI 服务暂时不可用' });
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`✅ 服务已启动，端口: ${PORT}`);
});