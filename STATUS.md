# Impact Trade AI — 專案狀態

## 部署網址

| 工具 | 網址 | 平台 |
|------|------|------|
| HUB 首頁 | https://impact-trade-ai.pages.dev | Cloudflare Pages |
| 232 關稅計算器 | https://impact-trade-ai.pages.dev/232-calculator.html | Cloudflare Pages |
| CBAM 計算器 | https://cbam-calculator.pages.dev | Cloudflare Pages |
| GAS Webhook | Google Apps Script（關稅諮詢導流） | GAS |

## 目前狀態（2026-04-16）

- GitHub → GAS 自動同步：✅ 已設定（`.github/workflows/sync-gas.yml`）
- 232 報告 email：✅ 六大區塊 + 精裝 Block6 + renderMarkdown 排版
- CBAM 報告 email：✅ 六大區塊 + 精裝 Block6 + renderMarkdown 排版
- Gemini 模型：`gemini-2.5-flash` → `gemini-2.5-flash-lite` → `gemini-2.0-flash-001`

## 待辦

- [ ] **GAS 部署新版本**（每次 push 後必須手動：部署 → 管理部署 → 新版本）
- [ ] 跑 `step3_sendTestEmail()` 驗證 232 報告最終格式
- [ ] 跑 `step_cbam_test()` 驗證 CBAM 報告最終格式
- [ ] 補發 `resend_lyipei_cbam()` 給真實用戶 lyipei@gmail.com

## 本 Session 完成的修改

### 核心修復
- Prompt 結構：`[BLOCK1] 指令` → `【BLOCK1 — 指令】` + 獨立輸出骨架（防止模型把指令當內容輸出）
- Output skeleton：移除 `（BLOCK# 內容）` 佔位符（防止模型短填）
- `callGeminiAPI()` maxOutputTokens：2048 → 4096（防截斷）
- `validateReport()` Block6 門檻：80 → 30 字（Block6 只寫 2 句 intro）

### Email 排版
- `renderMarkdown()`：markdown 轉 HTML，解決字擠在一起問題
- Block6 精裝版（232 + CBAM）：
  - 金色漸層卡片背景
  - 品牌三元素徽章：AI × 永續 × 國際
  - 頭銜 table 三欄：機構上、職稱下，不隨機斷行
  - 服務層次：`輕/中/重量級｜AI × 永續國際發展 + 功能名`
  - 服務 tag：60分鐘 / 實作落地 / 長期陪跑
  - 服務卡片 tag 加 `flex-shrink:0` + `margin-left:12px`

### Prompt 語氣強化
- 禁用詞：「值得注意的是」「綜上所述」「此外」「總體而言」等 AI 套語
- 禁用中國大陸用詞，強制台灣繁體中文
- Block6 禁用銷售詞：「誠摯邀請」「擘劃藍圖」「決策刻不容緩」「契機」
- Block6 prompt 注入實際數字，讓 AI 針對具體案例寫 intro

### 頭銜修正
- 「永續領導力碩士」→「永續領導力碩士班」（共 6 處：badge × 2、CTA 文字 × 2、system prompt × 2）
