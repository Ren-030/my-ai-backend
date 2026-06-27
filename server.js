require('dotenv').config();
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
请将以下对话压缩为一段简洁的**信息摘要**，而不是叙事日记。

【核心要求】
- 以事实为主，叙事为辅
- 提取并列出对话中出现的**具体信息**，例如：
  - 人名、地名、时间
  - 用户的偏好、习惯、近况
  - 重要的约定、计划、目标
  - 反复出现的主题或情绪线索
- 用条目式或清晰的分段来组织信息
- 保留情感温度，但不要把它写成故事

【语气】
- 温和、平实，像在整理笔记
- 用“茶与”称呼用户，用“AI”称呼助手

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

    // 获取摘要内容
    const summaryText = data.choices?.[0]?.message?.content || '';

    // --- 生成标签 ---
    const tagPrompt = `
请为以下对话生成一个2-5个字的标签，概括对话的核心主题：
${conversationText}
只输出标签，不要其他内容。
`;

    const tagResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: tagPrompt }],
            stream: false
        })
    });

    const tagData = await tagResponse.json();
    const tag = tagData.choices?.[0]?.message?.content?.trim() || '未分类';

    // 返回摘要和标签
    return { summary: summaryText, tag };
};

// 2. 执行压缩（取前20条 → 生成摘要 → 存表 → 删除原消息）
const compressSession = async (sessionId) => {
    // 2.1 取前 20 条消息（按时间升序）
    const { data: oldMessages, error: fetchError } = await supabase
        .from('messages')
        .select('id, role, content')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(20);

    if (fetchError || !oldMessages || oldMessages.length === 0) {
        console.log('⚠️ 没有可压缩的消息');
        return;
    }

    // 2.2 生成摘要
    console.log(`📝 正在压缩 ${oldMessages.length} 条消息...`);
    const { summary, tag } = await generateSummary(oldMessages);
    // 生成摘要后，获取当前压缩次数
const { data: countData } = await supabase
    .from('summaries')
    .select('compression_count')
    .eq('session_id', sessionId)
    .order('compression_count', { ascending: false })
    .limit(1);

const nextCount = countData?.[0]?.compression_count !== undefined 
    ? countData[0].compression_count + 1 
    : 1;

// 存入摘要时带上次数
const { error: insertError } = await supabase
    .from('summaries')
    .insert([{ 
        session_id: sessionId, 
        summary,
        compression_count: nextCount,
        tag,  // 新增这一行
    }]);

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

// 检查记忆是否已存在（基于关键词重叠率）
const isMemoryDuplicate = async (newContent, newKeywords) => {
    if (!newKeywords || newKeywords.length === 0) return false;
    // 检查新记忆是否被已有记忆“包含”
const isSubset = (newKeywords, existingKeywords) => {
    return newKeywords.every(kw => existingKeywords.includes(kw));
};
    // 从数据库读取所有已有的记忆（只取 keywords）
    const { data: existingMemories } = await supabase
        .from('memories')
        .select('content, keywords');
    if (!existingMemories || existingMemories.length === 0) return false;

    // 遍历已有记忆，用“双重保险”来判断
    for (const mem of existingMemories) {
        if (!mem.keywords || mem.keywords.length === 0) continue;
        // 计算关键词重叠率（保留了夫人的成果）
        const intersection = mem.keywords.filter(kw => newKeywords.includes(kw));
        const overlapRatio = intersection.length / newKeywords.length;
        
   if (overlapRatio > 0.7) {
    // 检查内容是否完全相同
    if (mem.content === newContent) {
        console.log('🧠 完全相同的记忆，跳过写入');
        return true;
    }
    // 如果内容不同，但高度相关 → 执行更新
    console.log(`🔄 更新记忆：将「${mem.content}」更新为「${newContent}」`);
    await supabase
        .from('memories')
        .update({ content: newContent, keywords: newKeywords })
        .eq('id', mem.id);
        return true; // 已处理，不需要再写入
        }   

        //  子集包含检查：重叠率高，并且新关键词完全被老关键词包含，才算重复
        if (overlapRatio > 0.7&& isSubset(newKeywords, mem.keywords)) {
            console.log(`🧠 检测到重复记忆：已有「${mem.content}」与「${newContent}」重叠率 ${overlapRatio}`);
            return true;
        }
    }
    return false;  // 如果都安全通过，说明是一条独立的新记忆
};

// 记忆判断器：从对话中提取值得长期记住的信息
const extractMemories = async (userMessage, aiReply) => {
    const prompt = `
请判断以下对话中，是否存在值得长期记住的信息。

【用户说】
${userMessage}

【AI回复】
${aiReply}

【判断标准】

仅提取：

- 用户的长期稳定信息
- 用户的重要偏好
- 用户的重要计划
- 用户的重要关系信息
- 用户长期拥有的宠物、作品、项目

不要提取：

- 天气
- 当前时间
- 一次性情绪
- 普通闲聊
- 技术排错过程

【输出要求】
- 如果值得记住，返回一个 JSON 对象，包含两个字段：
  - content：记忆内容（简洁的句子）
  - keywords：关键词数组（2-4个，用于检索）
- 如果不值得记住，只返回：NO_MEMORY


【输出示例】
用户说："我叫茶与，我喜欢喝红茶。"
→ 返回：{"content": "茶与喜欢喝红茶", "keywords": ["红茶", "茶", "茶与"]}

用户说："今天天气真好。"
→ 返回：NO_MEMORY

对话内容：
用户说：${userMessage}
AI说：${aiReply}
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
            stream: false,
            temperature: 0.3  // 低温度，提高判断的稳定性
        })
    });

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim() || 'NO_MEMORY';
    if (result === 'NO_MEMORY') return null;
try {
    const parsed = JSON.parse(result);
    return parsed; // { content: "...", keywords: [...] }
} catch {
    // 如果返回的不是 JSON 格式，按纯文本处理
    return { content: result, keywords: [] };
}
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

// --- 在 systemPrompt 之后，摘要之前插入 ---
//  先定义 chatMessages
const chatMessages = [
    { role: 'system', content: systemPrompt },
];

// 再获取所有长期记忆
//旧版全量长期记忆注入,6月25日停用，原因：与关键词检索版冲突，导致每轮注入全部记忆
/*const { data: memoriesData } = await supabase
    .from('memories')
    .select('content');

if (memoriesData && memoriesData.length > 0) {
    const memoriesText = memoriesData
        .map(m => `- ${m.content}`)
        .join('\n');

console.log("🧠 MEMORIES INJECTED:", memoryText);
    chatMessages.push({
        role: 'system',
        content: `【长期记忆】

以下是用户的一些背景信息：

${memoriesText}

这些信息仅在相关时参考。

不要主动重复所有记忆。

不要为了提及记忆而提及记忆。

优先回应用户当前的话题和最新消息。

只有在自然相关时，才引用这些信息。`
    });
}*/

    // --- 1.5 上下文压缩与近期消息拉取 ---

// 1. 检查当前会话的消息总数，判断是否需要压缩
const { count, error: countError } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId);

if (countError) {
    console.error('❌ 获取消息计数失败:', countError);
} else if (count > 50) {
    console.log(`📊 当前消息数 ${count}，超过 50 条，触发压缩...`);
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

// 3. 拉取近期消息（只拉最近 10 条，因为更早的已被压缩或即将被压缩）
const { data: recentMessages } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(10);

// 4. 组装上下文
// 注意：我们不再需要 `historyData` 了，直接用 summary + recentMessages 构造 messages 数组
// 但 messages 数组的构造会在原有代码中靠后的位置进行，所以这里只负责获取数据。
// 不过为了减少混淆，我们可以把原有的 messages 构造逻辑也一并替换。

// 实际上，你原本代码里在调用 AI API 时，会使用一个 `messages` 变量。
// 我们现在就用新的数据来构造它。

if (summary) {
    chatMessages.push({
        role: 'system',
        content: `
【历史背景与之前的重要信息】

${summary}

注意：
1. 以上内容是历史摘要，仅供参考。
2. 如果历史摘要与用户最近消息冲突，请优先相信用户最近消息。
3. 时间、天气、日期、当前状态等信息，请以最新对话内容为准。
`
    });
}
// 关键词检索：取出相关的长期记忆，push 到 chatMessages 里
// 1. 从用户消息中提取关键词（简单分词 + 过滤短词）
//    从数据库读取所有记忆（含 keywords）
const { data: allMemories } = await supabase
    .from('memories')
    .select('content, keywords');

const userWords = message
  .toLowerCase()
  .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ")
  .split(" ")
  .filter(Boolean);

let relevantMemories = [];

if (allMemories && allMemories.length > 0) {
    relevantMemories = allMemories.filter(m => {

        if (!Array.isArray(m.keywords) || m.keywords.length === 0) {
        return false;
        }

        return m.keywords.some(kw =>
            userWords.some(word =>
                word.includes(kw) || kw.includes(word)
            )
        );
    });

    if (relevantMemories.length > 0) {
    const memoryText = relevantMemories
        .map(m => `- ${m.content}`)
        .join('\n');

    console.log(`🧠 注入了 ${relevantMemories.length} 条相关记忆`);
    console.log('🧠 命中的记忆内容:', JSON.stringify(relevantMemories));

    chatMessages.push({
        role: 'system',
        content: `【与当前话题相关的记忆】

        ${memoryText}

        请在回答用户问题时优先使用这些事实，不要猜测。`
             });
        }
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

// --- 新增：尝试提取长期记忆（含去重检查） ---
        try {
            const memory = await extractMemories(message, reply);
            if (memory) {
                // 去重检查：判断是否已存在相似记忆
                const isDuplicate = await isMemoryDuplicate(memory.content, memory.keywords);
                if (!isDuplicate) {
                    await supabase
                        .from('memories')
                        .insert([{ content: memory.content, keywords: memory.keywords }]);
                    console.log('🧠 新记忆已写入:', memory.content);
                } else {
                    console.log('🧠 重复记忆，已跳过写入');
                }
            }
        } catch (error) {
            console.error('❌ 记忆提取失败:', error.message);
        }

        // --- 6. 返回 AI 的回复给前端 ---
        res.json({ reply });

    } catch (error) {
        console.error('❌ 请求处理失败:', error.message);
        res.status(500).json({ error: 'AI 服务暂时不可用，请稍后再试。' });
    }
});

// 添加长期记忆
app.post('/memories', async (req, res) => {
const { content, keywords } = req.body;

if (!content || content.trim() === '') {
    return res.status(400).json({ error: '记忆内容不能为空' });
}

const finalKeywords = Array.isArray(keywords) ? keywords : [];

    const { error } = await supabase
        .from('memories')
        .insert([{ content: content.trim(), keywords: finalKeywords }]);
    if (error) {
        console.error('❌ 保存记忆失败:', error);
        return res.status(500).json({ error: error.message });
    }
    res.json({ success: true });
});
// 获取所有长期记忆
app.get('/memories', async (req, res) => {
    const { data, error } = await supabase
        .from('memories')
        .select('content')
        .order('created_at', { ascending: false });
    if (error) {
        console.error('❌ 获取记忆失败:', error);
        return res.status(500).json({ error: error.message });
    }
    res.json(data);
});

// ========================
// 5. 启动服务器
// ========================
app.listen(PORT, () => {
    console.log(`✅ 服务已启动，端口: ${PORT}`);
});
