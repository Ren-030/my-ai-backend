const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 健康检查（你刚才验证的）
app.get('/ping', (req, res) => {
    res.send('I am alive!');
});

// 真正的 AI 对话接口（模拟版）
app.post('/chat', (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }
    // 模拟 AI 回复（稍后我们会换成真模型）
    const reply = `你刚才说：「${message}」。我现在只是一个模拟 AI，但很快我就能真正思考了！`;
    res.json({ reply });
});

app.listen(PORT, () => {
    console.log(`✅ 服务已启动，端口: ${PORT}`);
});