# 妙笔 - 测试用例

## 快速测试

### 测试 1：的地得错误
```json
{
  "text": "他跑的很快，慢慢的走路。",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期错误**：
- "跑的很快" → "跑得很快"
- "慢慢的走" → "慢慢地走"

---

### 测试 2：标点符号
```json
{
  "text": "这是测试 ，看看效果。。",
  "lang": "zh",
  "strictness": "strict"
}
```
**预期错误**：
- "测试 ，" → "测试，"（标点前空格）
- "。。" → "。"（标点重复）

---

### 测试 3：繁体字
```json
{
  "text": "國家學習電腦",
  "lang": "zh",
  "strictness": "basic"
}
```
**预期错误**：
- "國" → "国"
- "學" → "学"
- "電" → "电"
- "腦" → "脑"

---

### 测试 4：同音字混淆
```json
{
  "text": "在见，在哪里？做为一个例子。",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期错误**：
- "在见" → "再见"
- "做为" → "作为"

---

### 测试 5：重复词
```json
{
  "text": "我的的书在桌子上，这个这个问题很重要。",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期错误**：
- "的的" → "的"
- "这个这个" → "这个"

---

### 测试 6：数字格式
```json
{
  "text": "日期是2024.3.31，数量是１２３个。",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期错误**：
- "2024.3.31" → "2024年3月31日"
- "１２３" → "123"

---

### 测试 7：单位符号
```json
{
  "text": "温度25摄氏度，重量100千克，距离5千米。",
  "lang": "zh",
  "strictness": "strict"
}
```
**预期错误**：
- "25摄氏度" → "25 ℃"
- "100千克" → "100 kg"
- "5千米" → "5 km"

---

### 测试 8：全半角
```json
{
  "text": "这是ＡＢＣ和１２３的测试。",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期错误**：
- "ＡＢＣ" → "ABC"
- "１２３" → "123"

---

### 测试 9：空格问题
```json
{
  "text": "这  是  测试，100个苹果。",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期错误**：
- "这  是" → "这 是"
- "是  测试" → "是 测试"
- "100个" → "100 个"

---

### 测试 10：综合测试
```json
{
  "text": "他跑的很快 ，大概有100、200米的样子。這是測試。在见！",
  "lang": "zh",
  "strictness": "strict"
}
```
**预期错误**：
- "跑的很快" → "跑得很快"
- "快 ，" → "快，"
- "100、200" → "100～200"
- "這" → "这"
- "測" → "测"
- "試" → "试"
- "在见" → "再见"

---

## 使用 curl 测试

```bash
# 测试 1：的地得
curl -X POST http://localhost:3000/api/check \
  -H "Content-Type: application/json" \
  -d '{
    "text": "他跑的很快，慢慢的走路。",
    "lang": "zh",
    "strictness": "standard"
  }'

# 测试 2：繁体字
curl -X POST http://localhost:3000/api/check \
  -H "Content-Type: application/json" \
  -d '{
    "text": "國家學習電腦",
    "lang": "zh",
    "strictness": "basic"
  }'

# 测试 3：综合
curl -X POST http://localhost:3000/api/check \
  -H "Content-Type: application/json" \
  -d '{
    "text": "他跑的很快 ，大概有100、200米的样子。這是測試。在见！",
    "lang": "zh",
    "strictness": "strict"
  }'
```

---

## 在线试用页面测试

访问 http://localhost:3001/demo

### 测试文本 1
```
他跑的很快，慢慢的走路。
```

### 测试文本 2
```
這是一個測試，看看效果。國家學習電腦。
```

### 测试文本 3
```
在见！做为一个例子，这个这个问题很重要。
```

### 测试文本 4
```
温度25摄氏度，重量100千克，距离5千米。日期是2024.3.31。
```

---

## 预期结果格式

```json
{
  "errors": [
    {
      "type": "typo",
      "start": 2,
      "end": 3,
      "message": "动词后表示程度应使用"得"",
      "suggestion": "跑得很快",
      "original": "跑的很快"
    }
  ],
  "processedAt": "2024-03-31T12:00:00.000Z",
  "stats": {
    "total": 1,
    "typo": 1,
    "grammar": 0,
    "punctuation": 0
  }
}
```

---

## 性能测试

### 短文本（100字以内）
- 预期响应时间：< 50ms
- 测试文本：100字的文章

### 中等文本（1000字）
- 预期响应时间：< 200ms
- 测试文本：1000字的文章

### 长文本（5000字）
- 预期响应时间：< 1s
- 测试文本：5000字的文章

---

## 边界测试

### 空文本
```json
{
  "text": "",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期**：返回空错误列表

### 纯英文
```json
{
  "text": "This is a test.",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期**：无错误或少量错误

### 纯数字
```json
{
  "text": "123456789",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期**：可能提示千分位

### 特殊字符
```json
{
  "text": "!@#$%^&*()",
  "lang": "zh",
  "strictness": "standard"
}
```
**预期**：无错误或标点相关错误
