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

// ====== Embedding 工具函数 ======
const getEmbedding = async (text) => {
    try {
        const response = await fetch('https://api.siliconflow.cn/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'BAAI/bge-large-zh-v1.5',
                input: text
            })
        });

        if (!response.ok) {
            console.error('❌ Embedding API 请求失败:', response.status);
            return null;
        }

        const data = await response.json();
        // 检查返回数据结构
        if (data && data.data && data.data.length > 0 && data.data[0].embedding) {
            return data.data[0].embedding;
        } else {
            console.error('❌ Embedding API 返回数据格式异常:', JSON.stringify(data).slice(0, 200));
            return null;
        }
    } catch (error) {
        console.error('❌ 生成向量失败:', error.message);
        return null;
    }
};

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

    // ---------- 工具函数与配置 ----------
    // 关键词归一化（去掉“小”“大”等前缀，并做同义词映射）
    const normalize = kw => {
        let word = kw.replace(/^小/, '').replace(/^大/, '').trim();
        const synonymMap = {
            '狗狗': '狗',
            '猫猫': '猫',
            '兔兔': '兔',
            '仓鼠': '仓鼠', // 保持不变
        };
        return synonymMap[word] || word;
    };

    // 关键词停用词列表（用于去除无意义的词）
    const STOPWORDS = [
        '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
        '的', '了', '在', '是', '有', '和', '与', '或', '但', '因为', '所以',
        '用户', 'AI', 'claude', '茶与', '小窝', '长期记忆', '项目',
        '一个', '一只', '一条', '一种', '这个', '那个', '什么', '怎么', '如何',
        '宠物', '动物', '东西', '事情' // 泛化词
    ];

    // 短句对长句的包含检查（子集判定）
    const isShortContainedInLong = (short, long) => {
        return short.every(kw => long.includes(kw));
    };

    // ---------- 提前过滤新记忆的关键词 ----------
    const filteredNew = newKeywords
        .map(normalize)
        .filter(kw => kw.length > 0 && !STOPWORDS.includes(kw));

    console.log('🔍 新记忆关键词（过滤前）:', newKeywords);
    console.log('🔍 新记忆关键词（过滤后）:', filteredNew);

    // ---------- 从数据库获取所有旧记忆 ----------
    const { data: existingMemories } = await supabase
        .from('memories')
        .select('id, content, keywords');

    if (!existingMemories || existingMemories.length === 0) {
        console.log('🧠 数据库中没有旧记忆，无需去重');
        return false;
    }

    // ========== 1. 优先检查更新信号（放在所有去重检查之前）==========
    const updateSignals = ['改为', '更喜欢', '现在是', '变成', '已经', '开始'];
    const shouldUpdate = updateSignals.some(signal => newContent.includes(signal));

    if (shouldUpdate) {
        console.log('🔍 检测到更新信号，尝试寻找最相似的旧记忆进行替换...');
        const newEmbedding = await getEmbedding(newContent);

        if (newEmbedding) {
            const { data: similarMemories } = await supabase
                .rpc('match_memories', {
                    query_embedding: newEmbedding,
                    match_threshold: 0.6,   // 高于这个阈值才认为“足够相似”
                    match_count: 1          // 只取最相似的那一条
                });

            if (similarMemories && similarMemories.length > 0) {
                const target = similarMemories[0];
                console.log(`🔄 成功找到最匹配的旧记忆！id=${target.id}，原内容是: "${target.content}"`);

                // 更新这条旧记忆
                await supabase
                    .from('memories')
                    .update({
                        content: newContent,
                        keywords: newKeywords,
                        embedding: newEmbedding
                    })
                    .eq('id', target.id);

                console.log(`🔄 更新成功：已把旧记忆替换为新记忆「${newContent}」`);
                return true; // 已处理，不再作为新记忆写入
            } else {
                console.log('🔄 没发现足够相似的旧记忆，将进入常规去重检查（或作为新记忆写入）');
                // 继续执行后续去重逻辑，不要直接返回 false
            }
        } else {
            console.log('🔄 无法生成 embedding，跳过更新，进入常规去重检查');
        }
    }

    // ========== 2. 常规去重检查 ==========
    for (const mem of existingMemories) {
        if (!mem.keywords || mem.keywords.length === 0) continue;

        // 过滤旧记忆关键词
        const filteredOld = mem.keywords
            .map(normalize)
            .filter(kw => kw.length > 0 && !STOPWORDS.includes(kw));

        console.log('🔍 旧记忆关键词（过滤后）:', filteredOld);

        // 2.1 内容完全相同的记忆 → 去重
        if (mem.content === newContent) {
            console.log('🧠 内容完全相同的旧记忆，跳过写入');
            return true;
        }

        // 2.2 归一化+停用词过滤后的双向子集包含 → 去重
        if (filteredNew.length > 0 && filteredOld.length > 0) {
            const newIsSubset = isShortContainedInLong(filteredNew, filteredOld);
            const oldIsSubset = isShortContainedInLong(filteredOld, filteredNew);
            if (newIsSubset || oldIsSubset) {
                console.log('🧠 归一化+停用词过滤后，短句被长句包含 → 判定为重复，跳过写入');
                return true;
            }
        }

        // 2.3 基于原始关键词的重叠率（用 max 做分母，更公平）
        const intersection = mem.keywords.filter(kw => newKeywords.includes(kw));
        const overlapRatio = intersection.length / Math.max(newKeywords.length, mem.keywords.length);

        if (overlapRatio > 0.7) {
            console.log(`🧠 关键词重叠率过高 (${overlapRatio.toFixed(2)}) → 判定为重复，跳过写入`);
            return true;
        }
    }

    // 所有检查通过，未发现重复，允许写入新记忆
    console.log('✅ 未发现重复记忆，允许写入新记忆');
    return false;
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
- 用户长期拥有的作品、项目
- 用户提到自己拥有的、关心的、日常相关的人或物（宠物、家人、爱好、饮食或饮品偏好、习惯），请提取为长期记忆。

不要提取：

- 天气
- 当前时间
- 一次性情绪
- 普通闲聊
- 技术排错过程

【输出要求】
- 如果值得记住，返回一个 JSON 对象，包含两个字段：
  - content：记忆内容（简洁的句子）
  - keywords：关键词数组（2-3个，用于检索）
- 如果不值得记住，只返回：NO_MEMORY

【关键词提取规则（重要）】
1. 只保留最能代表事实的名词或专有名词。
2. 不要输出这些词：用户、喜欢、有、是、现在、之前、一个、东西、宠物、情况、状态。
3. 如果存在多个表达，统一使用最基础的实体名称：
   - 小猫、猫咪、猫猫 → 猫
   - 小狗、狗狗 → 狗
   - 小仓鼠 → 仓鼠
4. 不要输出修饰词（小、很、特别、超级等）。
5. 最多输出 3 个关键词。

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

// 假设你已经得到了 result
    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim() || 'NO_MEMORY';

    if (result === 'NO_MEMORY') {
        return null;
    }

    let parsedResult;
    try {
        parsedResult = JSON.parse(result);
    } catch {
        parsedResult = { content: result, keywords: [] };
    }

    // 兜底归一化小助手
    const normalizeKeywords = (keywords) => {
        const map = {
            '小猫': '猫', '猫咪': '猫', '猫猫': '猫',
            '小狗': '狗', '狗狗': '狗',
            '小仓鼠': '仓鼠',
        };
        return keywords
            .map(kw => map[kw] || kw)
            .filter(kw => !['用户', '喜欢', '有', '是', '现在', '之前', '一个', '东西', '宠物', '情况', '状态'].includes(kw))
            .slice(0, 3);
    };

    if (parsedResult.keywords) {
        parsedResult.keywords = normalizeKeywords(parsedResult.keywords);
    }

    return parsedResult;
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
        // ---------- 1. 获取设置（优先前端传参，否则读数据库） ----------
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

        // ---------- 2. 初始化消息数组，放入 system 设定 ----------
        const chatMessages = [
            { role: 'system', content: systemPrompt }
        ];

        // ---------- 3. 上下文压缩（消息数 > 50 触发） ----------
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

        // ---------- 4. 获取历史摘要（最新一条） ----------
        const { data: summaryData } = await supabase
            .from('summaries')
            .select('summary')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: false })
            .limit(1);

        const summary = summaryData?.[0]?.summary || '';

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
            console.log('📜 历史摘要已注入');
        }

        // ---------- 5. 混合检索 + Memory Mode ----------
    const userEmbedding = await getEmbedding(message);
    let memories = [];

    if (userEmbedding) {
    // ====== Memory Mode：根据对话意图决定阈值 ======
    let threshold = 0.55; // 默认：普通闲聊
    
    const isUpdate = message.match(/以前|现在|之前|改为|更喜欢|开始/);
    const isMemoryQuery = message.match(/还记得|我养了|我喜欢|我有什么|我的宠物|我的猫|我的狗|你知道吗|你记得吗/);
    
    if (isUpdate) {
        threshold = 0.75;   // 更新模式：只匹配高度相关的记忆
    } else if (isMemoryQuery) {
        threshold = 0.4;    // 记忆查询：放宽阈值，召回更多候选
    } else {
        threshold = 0.55;   // 普通闲聊：只注入非常相关的记忆
    }
    
    console.log(`🧠 Memory Mode: ${isUpdate ? 'UPDATE' : isMemoryQuery ? 'QUERY' : 'CHAT'}，阈值: ${threshold}`);
    
    // ====== 执行检索 ======
    const { data: matchedData, error: rpcError } = await supabase
        .rpc('match_memories', {
            query_embedding: userEmbedding,
            match_threshold: 0.4,   // RPC 本身用 0.4 召回
            match_count: 10
        });
    
    if (rpcError) {
        console.error('❌ 向量检索出错:', rpcError);
    } else {
        console.log(`🧠 向量检索原始结果 ${matchedData?.length || 0} 条`);
        
        // 用 Memory Mode 阈值做二次过滤
        const filtered = (matchedData || []).filter(item => item.similarity > threshold);
        memories = filtered.map(item => ({
            content: item.content,
            similarity: item.similarity
        }));
        
        console.log(`🧠 过滤后（阈值 ${threshold}）得到 ${memories.length} 条记忆`);
        
        // ====== 如果过滤后少于 2 条，且是 Memory Query，用关键词检索补充 ======
        if (memories.length < 2 && isMemoryQuery) {
            console.log(`🔍 记忆不足 2 条，且为 QUERY 模式，开始关键词检索补充...`);
            
            const userWords = message.split(/[\s,，。！？、；：""''（）\n]+/).filter(w => w.length > 1);
            if (userWords.length > 0) {
                const { data: keywordMatches, error: kwError } = await supabase
                    .from('memories')
                    .select('content, keywords')
                    .overlaps('keywords', userWords);
                
                if (kwError) {
                    console.error('❌ 关键词检索出错:', kwError);
                } else if (keywordMatches && keywordMatches.length > 0) {
                    console.log(`🔍 关键词检索命中 ${keywordMatches.length} 条`);
                    
                    const existingContents = new Set(memories.map(m => m.content));
                    keywordMatches.forEach(k => {
                        if (!existingContents.has(k.content)) {
                            memories.push({
                                content: k.content,
                                similarity: 0
                            });
                            existingContents.add(k.content);
                        }
                    });
                    console.log(`🔍 补充后记忆总数 ${memories.length}`);
                } else {
                    console.log('🔍 关键词检索无命中');
                }
            } else {
                console.log('🔍 用户消息分词后无有效词，跳过关键词检索');
            }
        }
    }
} else {
    console.log('⚠️ 无法生成用户消息向量，跳过 Embedding 检索');
}

// 注入记忆到 chatMessages
    if (memories.length > 0) {
    const memoryText = memories.map(m => `- ${m.content}`).join('\n');
    chatMessages.push({
        role: 'system',
        content: `【与当前话题相关的记忆】\n${memoryText}\n只参考这些信息。除非用户明确问及，否则不要在回复中主动罗列这些记忆。`
     });
    console.log(`🧠 最终注入 ${memories.length} 条记忆到上下文`);
    console.log('🧠 命中的记忆内容:', JSON.stringify(memories.map(m => m.content)));
} else {
    console.log('🧠 未检索到任何相关记忆，跳过注入');
}

        // ---------- 6. 获取最近 10 条消息（用于上下文延续） ----------
        const { data: recentMessages } = await supabase
            .from('messages')
            .select('role, content')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true })
            .limit(10);

        // 添加近期消息（注意转换 role）
        (recentMessages || []).forEach(msg => {
            chatMessages.push({
                role: msg.role === 'ai' ? 'assistant' : msg.role,
                content: msg.content
            });
        });
        console.log(`📝 已加载最近 ${recentMessages?.length || 0} 条对话`);

        // 添加当前用户消息
        chatMessages.push({ role: 'user', content: message });

        // ---------- 7. 保存用户消息到数据库 ----------
        const { error: userError } = await supabase
            .from('messages')
            .insert([{ role: 'user', content: message, session_id: sessionId }]);
        if (userError) {
            console.error('❌ 保存用户消息失败:', userError.message);
        } else {
            console.log('✅ 用户消息已存入 Supabase');
        }

        // ---------- 8. 调用 AI API（支持多模型） ----------
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

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: chatMessages,
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

        // ---------- 9. 保存 AI 回复 ----------
        const { error: aiError } = await supabase
            .from('messages')
            .insert([{ role: 'ai', content: reply, session_id: sessionId }]);
        if (aiError) {
            console.error('❌ 保存 AI 回复失败:', aiError.message);
        } else {
            console.log('✅ AI 回复已存入 Supabase');
        }

        // ---------- 10. 尝试提取长期记忆（含去重、向量化） ----------
        try {
            const memory = await extractMemories(message, reply);
            console.log('🔍 进入记忆写入流程，memory 值:', memory);
            if (memory) {
                console.log('🔍 memory 存在，进入去重检查...');
                const isDuplicate = await isMemoryDuplicate(memory.content, memory.keywords);
                if (!isDuplicate) {
                    const embedding = await getEmbedding(memory.content);
                    if (embedding) {
                        await supabase.from('memories').insert([{
                            content: memory.content,
                            keywords: memory.keywords,
                            embedding: embedding
                        }]);
                        console.log('🧠 新记忆已写入（含向量）');
                    } else {
                        await supabase.from('memories').insert([{
                            content: memory.content,
                            keywords: memory.keywords
                        }]);
                        console.log('🧠 新记忆已写入（无向量，回退）');
                    }
                } else {
                    console.log('🧠 重复记忆，已跳过写入');
                }
            } else {
                console.log('🔍 memory 为空，跳过写入');
            }
        } catch (error) {
            console.error('❌ 记忆提取失败:', error.message);
        }

        // ---------- 11. 返回回复 ----------
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
