// ============================================================
// 覺心營 Impact Trade AI — GAS Webhook + 六大區塊報告自動化
// ============================================================
// Script Properties 設定位置：
//   GAS 編輯器左側 ⚙ Project Settings → 捲到底 → Script Properties
//
// 需設定的 Properties：
//   WEBHOOK_SECRET  — 驗證前端請求（任意自訂字串，如 ahbase2026）
//   SHEET_ID        — Google Sheet ID（URL 中 /d/ 後面那段）
//   GEMINI_API_KEY  — 從 aistudio.google.com 免費取得（Get API key）
//   TEMPLATE_DOC_ID — Google Doc 模板 ID（非必要，無此值仍可發 email）
// ============================================================

var PAIN_POINT_MAP = {
  A: '找不到替代供應商或調整生產線',
  B: '美國客戶要求降價或考慮換供應商',
  C: '不知道如何和美國買家談判漲價',
  D: '正在評估是否轉向其他市場或供應鏈'
};

// 官方資料來源（已查核）
var OFFICIAL_SOURCES = [
  '美國聯邦公報 Proclamation 11021（2026/4/6 生效）：https://www.federalregister.gov/',
  '美國海關邊境保護局（CBP）232 條款指引：https://www.cbp.gov/trade/programs-administration/entry-summary/232-tariffs',
  '美國貿易代表辦公室（USTR）台美 ART 資訊：https://ustr.gov/countries-regions/china/section-301-investigations/retaliatory-actions',
  '台灣經濟部貿易局 232 條款說明：https://www.trade.gov.tw/'
];

// ── 1. Webhook 入口 ─────────────────────────────────────────

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    // 1. 驗證 Webhook Secret
    var secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    if (secret && payload.secret !== secret) {
      return jsonResponse({ status: 'error', message: 'unauthorized' });
    }

    // 2. 依工具類型路由
    if (payload.tool === 'cbam') {
      // ── CBAM 碳邊境稅計算器 ──
      var cbamData = {
        email:           payload.email           || '',
        challenge:       payload.challenge        || 'N/A',
        productCategory: payload.productCategory  || '未填寫',
        productSub:      payload.productSub       || '未填寫',
        volume:          payload.volume           || '0',
        intensity:       payload.intensity        || '0',
        cbamEur:         payload.cbamEur          || '0',
        cbamNtd:         payload.cbamNtd          || '0',
        submittedAt:     payload.submittedAt      || ''
      };
      appendCbamToSheet(cbamData);
      processCbamReport(cbamData);
      Logger.log('CBAM doPost OK: ' + cbamData.email);
      return jsonResponse({ status: 'ok', message: 'CBAM report sent.' });
    }

    // ── 232 關稅計算器（預設）──
    var data = {
      email:            payload.email            || '',
      challenge:        payload.challenge        || 'none',
      product_price:    payload.product_price    || '0',
      product_category: payload.product_category || '未填寫',
      steel_cost:       payload.steel_cost       || '0',
      weight_pct:       payload.weight_pct       || '0',
      old_tariff:       payload.old_tariff       || '0',
      new_tariff:       payload.new_tariff       || '0',
      diff_amt:         payload.diff_amt         || '0',
      diff_pct:         payload.diff_pct         || '0',
      margin_pct:       payload.margin_pct       || '20',
      scen_a_margin:    payload.scen_a_margin    || '0',
      scen_b_price:     payload.scen_b_price     || '0',
      weight_exempt:    payload.weight_exempt    || '不符合'
    };

    // 3. 記錄到 Google Sheet
    appendToSheet(data);

    // 4. 立即生成報告並寄出 Email
    processAndSendReport(data);

    Logger.log('doPost & Report Sent OK: ' + data.email);
    return jsonResponse({ status: 'ok', message: 'Report generated and sent.' });

  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

// 為了讓結構清晰，請在 doPost 下方新增這個 processAndSendReport 函數
// ── 品質驗證：確認六大區塊都有實質內容（每區塊至少 80 字）────
function validateReport(blocks) {
  for (var i = 1; i <= 6; i++) {
    var block = blocks['b' + i];
    if (!block || block.trim().length < 80) {
      return false;
    }
  }
  return true;
}

function processAndSendReport(data) {
  try {
    // 呼叫 Gemini API 產生文字報告
    var report = callGeminiAPI(data);
    var blocks = parseBlocks(report);

    // ── 品質關卡：任何區塊為空或過短 → 不寄客戶，改發警報給 Jessie ──
    if (!validateReport(blocks)) {
      Logger.log('⚠️ 報告品質不合格，已攔截，通知 Jessie 手動處理。');
      GmailApp.sendEmail(
        'jessie@ahbase.com',
        '【⚠️ 需人工處理】232 報告品質不合格 — ' + data.email,
        '',
        {
          htmlBody:
            '<p style="font-family:Arial;color:#E84000;font-weight:bold;">報告品質未達標，已攔截，請手動處理。</p>' +
            '<p><b>客戶 Email：</b>' + data.email + '</p>' +
            '<p><b>產品分類：</b>' + data.product_category + '</p>' +
            '<p><b>Gemini 原始輸出：</b></p>' +
            '<pre style="background:#f5f5f5;padding:12px;font-size:12px;white-space:pre-wrap;">' + (report || '（空白）') + '</pre>',
          name: 'Impact Trade AI 系統',
          replyTo: 'jessie@ahbase.com'
        }
      );
      return;
    }

    // 生成 PDF 報告（需有 TEMPLATE_DOC_ID）
    var pdfBlob = generateReport(data, report);

    var mailOpts = {
      htmlBody: buildEmailHtml(data, report),
      name:     'Jessie Chang · 覺心營',
      replyTo:  'jessie@ahbase.com'
    };

    // 如果 PDF 生成成功就加入附件
    if (pdfBlob) mailOpts.attachments = [pdfBlob];

    // 寄出 Email
    GmailApp.sendEmail(
      data.email,
      '【覺心營】你的 2026 美國 232 關稅衝擊策略報告',
      '請以 HTML 格式查看此郵件。',
      mailOpts
    );
    Logger.log('✅ 報告品質合格，已寄出至：' + data.email);

  } catch (err) {
    Logger.log('processAndSendReport error: ' + err.toString());
    // 錯誤時只通知 Jessie，不寄任何內容給客戶
    try {
      GmailApp.sendEmail(
        'jessie@ahbase.com',
        '【⚠️ 系統錯誤】232 報告生成失敗 — ' + data.email,
        '',
        {
          htmlBody:
            '<p style="font-family:Arial;color:#E84000;font-weight:bold;">報告生成失敗，請手動聯繫客戶。</p>' +
            '<p><b>客戶 Email：</b>' + data.email + '</p>' +
            '<p><b>錯誤訊息：</b>' + err.toString() + '</p>',
          name: 'Impact Trade AI 系統',
          replyTo: 'jessie@ahbase.com'
        }
      );
    } catch (e) {
      Logger.log('Alert email failed: ' + e.toString());
    }
  }
}

// ── 2. 記錄 Google Sheet（完整 16 欄）───────────────────────

function appendToSheet(data) {
  try {
    var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!sheetId) { Logger.log('SHEET_ID not set, skipping'); return; }

    var sheet = SpreadsheetApp.openById(sheetId).getActiveSheet();

    // 若第一列為空，自動建立標題列
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        '時間戳', 'Email', '挑戰痛點代號', '挑戰痛點說明',
        '產品售價(USD)', '產品分類(Annex)', '鋼鋁材料成本(USD)', '鋼鋁重量佔比(%)',
        '舊制關稅(USD)', '新制關稅(USD)', '關稅差額(USD)', '關稅增幅',
        '預期毛利率(%)', '情境A稅後毛利率', '情境B建議新報價(USD)', '重量豁免資格'
      ]);
    }

    sheet.appendRow([
      Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss'),
      data.email            || '',
      data.challenge        || '',
      PAIN_POINT_MAP[data.challenge] || data.challenge || '',
      data.product_price    || '',
      data.product_category || '',
      data.steel_cost       || '',
      data.weight_pct       || '',
      data.old_tariff       || '',
      data.new_tariff       || '',
      data.diff_amt         || '',
      data.diff_pct         || '',
      (data.margin_pct || '') + '%',
      data.scen_a_margin    || '',
      data.scen_b_price     || '',
      data.weight_exempt    || ''
    ]);

  } catch (err) {
    Logger.log('appendToSheet error: ' + err.toString());
  }
}

// ── 3. 延遲發送 ──────────────────────────────────────────────

function sendDelayedReport() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var keys  = Object.keys(props).filter(function(k) { return k.indexOf('TRIGGER_') === 0; }).sort();

  if (keys.length === 0) { cleanupTriggers(); return; }

  var key  = keys[0];
  var data;
  try {
    data = JSON.parse(props[key]);
  } catch (err) {
    Logger.log('Parse trigger failed: ' + err.toString());
    PropertiesService.getScriptProperties().deleteProperty(key);
    cleanupTriggers();
    return;
  }
  PropertiesService.getScriptProperties().deleteProperty(key);

  try {
    var report  = callGeminiAPI(data);        // 六大區塊內容
    var pdfBlob = generateReport(data, report); // 合併進 Doc 模板

    var mailOpts = {
      htmlBody: buildEmailHtml(data, report),
      name:     'Jessie Chang · 覺心營',
      replyTo:  'jessie@ahbase.com'
    };
    if (pdfBlob) mailOpts.attachments = [pdfBlob];

    GmailApp.sendEmail(
      data.email,
      '【覺心營】你的 2026 美國 232 關稅衝擊策略報告',
      '請以 HTML 格式查看此郵件。',
      mailOpts
    );
    Logger.log('Report sent to: ' + data.email);

  } catch (err) {
    Logger.log('sendDelayedReport error: ' + err.toString());
    try {
      GmailApp.sendEmail(
        data.email,
        '【覺心營】你的 232 關稅衝擊策略報告（正在準備中）',
        '感謝你使用 Impact Trade AI。Jessie Chang 將在 72 小時內親自與你聯繫，提供個人化顧問建議。',
        { name: 'Jessie Chang · 覺心營', replyTo: 'jessie@ahbase.com' }
      );
    } catch (e2) { Logger.log('Fallback email failed: ' + e2.toString()); }
  }

  cleanupTriggers();
}

// ── 4. Claude API — 六大區塊報告生成 ────────────────────────

// ── 4a. 產生 Prompt（獨立函數，方便測試審閱）──────────────

function buildPrompt(data) {
  var painPoint    = PAIN_POINT_MAP[data.challenge] || '業務衝擊評估';
  var scenAMargin  = parseFloat(data.scen_a_margin) || 0;
  var isLoss       = scenAMargin < 0;
  var marginPct    = data.margin_pct || '20';
  var weightExempt = data.weight_exempt === '符合';

  var systemPrompt =
    '你是覺心營執行長 Jessie Chang（劍橋大學 CISL 永續領導力碩士、Asia Impact Nexus 台灣負責人）的顧問助理。\n' +
    '請以國際貿易策略顧問的專業口吻，用繁體中文撰寫企業主可直接使用的策略報告內容。\n\n' +
    '【語言與語氣規則——違反即重寫】\n' +
    '1. 禁止 AI 腔調：不得出現「值得注意的是」「需要指出的是」「綜上所述」「此外」「總體而言」「不容忽視」「首先」「其次」「最後」等套語\n' +
    '2. 必須使用台灣繁體中文用詞，禁止中國大陸用詞：\n' +
    '   - 軟體（非「软件」）、網路（非「网络」）、資訊（非「信息」）、協作（非「协同」）\n' +
    '   - 供應商（非「供应商」）、採購（非「采购」）、報價（非「报价」）\n' +
    '3. 語氣：直接、精準、務實——像頂尖顧問對董事會說話，不像 AI 寫給大眾的文章\n' +
    '4. 所有建議策略和話術，必須基於真實的國際貿易實務（如 Incoterms 條款、海關估值規定、買賣合約結構），不可自行捏造\n\n' +
    '【事實規則】\n' +
    '5. 所有政策事實基於已生效的美國法規，不得推測或捏造\n' +
    '6. 2026/4/6 起，美國 232 關稅改為對整個產品出口售價（海關申報價值）課稅，非僅鋼鋁材料成本\n' +
    '7. 台灣不在美國鋼鋁 232 關稅的正式豁免名單（EU、英國、日本、韓國、USMCA 國家才在）\n' +
    '8. 台美 ART（2026/2/12 定稿）主要涵蓋汽車零件、木材類，一般鋼鋁製品仍面對全額 232\n' +
    '9. 重量豁免（de minimis）：鋼鋁衍生製品若鋼鋁重量佔比 < 15% 可申請豁免，但需海關正式裁定\n' +
    '10. 數字必須與企業資料完全一致，不得自行更改任何數值';

  var userPrompt =
    '【格式強制規則 — 最高優先，不得違反】\n' +
    '1. 輸出必須且只能包含 [BLOCK1] 至 [BLOCK6] 共六個區塊\n' +
    '2. 每個區塊以 [BLOCK1]、[BLOCK2]...標籤開頭（方括號，大寫，無空格）\n' +
    '3. 禁止輸出任何報告標題、前言、問候語、介紹文字\n' +
    '4. 第一個字必須是 [BLOCK1]，最後一個區塊是 [BLOCK6]\n' +
    '5. 若你無法遵守此格式，請直接回覆「FORMAT_ERROR」\n\n' +
    '請為以下企業生成六大區塊報告內容：\n\n' +

    '【企業關稅計算資料】\n' +
    '- 產品出口售價：$' + data.product_price + ' USD\n' +
    '- 鋼鋁材料成本：$' + data.steel_cost + ' USD\n' +
    '- 鋼鋁重量佔比：' + data.weight_pct + '%\n' +
    '- 產品 Annex 分類：' + data.product_category + '\n' +
    '- 舊制關稅（材料成本 × 稅率）：$' + data.old_tariff + '\n' +
    '- 新制關稅（整體售價 × 稅率）：$' + data.new_tariff + '\n' +
    '- 關稅增加金額：$' + data.diff_amt + '\n' +
    '- 關稅增幅：' + data.diff_pct + '\n' +
    '- 預期毛利率：' + marginPct + '%\n' +
    '- 情境A（企業全額吸收）稅後毛利率：' + data.scen_a_margin + '\n' +
    '- 情境B（完全轉嫁買家）建議新報價：$' + data.scen_b_price + '\n' +
    '- 重量豁免資格初步判定：' + data.weight_exempt + '\n' +
    '- 企業最大挑戰：' + painPoint + '\n\n' +

    '[BLOCK1] 執行摘要\n' +
    '用 2-3 句直接點出財務衝擊：關稅從多少增加到多少、增加了幾倍。' +
    (isLoss ? '必須明確指出若自行吸收將直接虧損。' : '') + '\n\n' +

    '[BLOCK2] 政策現實確認\n' +
    '說明三件事：\n' +
    '① 台灣目前不在美國232正式豁免名單（列出誰在名單：EU/英/日/韓/USMCA）\n' +
    '② 台美ART已於2026/2/12定稿，但主要涵蓋汽車零件/木材，此類產品仍面對全額232\n' +
    (weightExempt
      ? '③ 此企業鋼鋁重量佔比 ' + data.weight_pct + '% 低於 15%，具備重量豁免（de minimis）申請潛力，但需向海關申請正式裁定（Ruling），強烈建議諮詢報關行或貿易律師確認。'
      : '③ 此企業鋼鋁重量佔比 ' + data.weight_pct + '% 超過 15%，不符合重量豁免條件。') + '\n\n' +

    '[BLOCK3] 利潤壓力分析\n' +
    (isLoss
      ? '【緊急警告】情境A顯示若企業全額吸收新制關稅，稅後毛利率將降至 ' + data.scen_a_margin + '，直接陷入虧損。\n'
      : '情境A若自行吸收，稅後毛利率剩 ' + data.scen_a_margin + '，分析此毛利率是否仍能維持營運。\n') +
    '情境B若完全轉嫁，建議新報價 $' + data.scen_b_price + '，分析美國買家接受度風險。\n' +
    '提供：如何計算最低盈虧平衡報價的思路（公式說明）。\n\n' +

    '[BLOCK4] 三個立即可用的談判話術\n' +
    '針對挑戰「' + painPoint + '」，提供三個話術，格式：\n' +
    '話術一：【情境】【中文版本】【English version（30 words max）】\n' +
    '話術二：同上格式\n' +
    '話術三：同上格式\n' +
    '核心論點：這是美國聯邦法規強制要求，全台供應鏈均受影響，非廠商自主調漲。\n\n' +

    '[BLOCK5] 30天立即行動計劃\n' +
    '三個具體行動，每個包含：行動名稱、具體步驟、預期效果。\n' +
    (isLoss ? '第一個行動必須標注【緊急】。\n' : '') +
    '行動範圍：重新核算成本結構、買家溝通策略、供應鏈或市場多元化評估。\n\n' +

    '[BLOCK6] 下一步：覺心營顧問服務\n' +
    '一段激勵結語，說明面對這樣的衝擊，企業需要的不只是計算器，而是系統性的應對策略。\n' +
    '帶出 Jessie Chang 的背景（UNDP SDG Impact Standard 認證講師 劍橋大學 永續領導力碩士班、Asia Impact Nexus 台灣負責人）。\n' +
    '提供三個層次的服務選項（輕/中/重），並附上諮詢邀請。';

  return { system: systemPrompt, user: userPrompt };
}

// ── 4b. 呼叫 Gemini API ───────────────────────────────────

function callGeminiAPI(data) {
  var maxRetries = 3;
  var sleepTime = 2000;
  // 主力：2.5-flash（最強）→ 備援：2.0-flash（穩定）
  var models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-001'];

  for (var m = 0; m < models.length; m++) {
  for (var i = 0; i < maxRetries; i++) {
    try {
      var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
      var prompt = buildPrompt(data);
      var fullPrompt = prompt.system + '\n\n---\n\n' + prompt.user;

      var response = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1/models/' + models[m] + ':generateContent?key=' + apiKey,
        {
          method: 'post',
          headers: { 'Content-Type': 'application/json' },
          payload: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
          }),
          muteHttpExceptions: true
        }
      );

      var responseCode = response.getResponseCode();
      var raw = response.getContentText();

      // 處理過載 (429/503)
      if (responseCode === 429 || responseCode === 503) {
        Logger.log('⚠️ 模型 ' + models[m] + ' 回傳 ' + responseCode + '，第 ' + (i+1) + ' 次重試...');
        Utilities.sleep(sleepTime * (i + 1));
        continue;
      }

      var result;
      try {
        result = JSON.parse(raw);
      } catch (e) {
        throw new Error('❌ Gemini 回傳格式非 JSON: ' + raw.substring(0, 200));
      }

      // 如果 API 回傳內容中有明確的 error 欄位
      if (result.error) {
        throw new Error('❌ Gemini API 報錯: ' + result.error.message);
      }

      // 檢查是否有正確生成內容
      if (result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts) {
        return result.candidates[0].content.parts[0].text;
      } 
      
      // 處理被安全過濾器攔截的情況
      if (result.candidates && result.candidates[0].finishReason === 'SAFETY') {
        throw new Error('❌ 內容因安全機制被攔截 (SAFETY)。');
      }

      throw new Error('❌ API 回傳內容結構不符預期，原始內容：' + raw.substring(0, 200));

    } catch (err) {
      if (i === maxRetries - 1) {
        Logger.log('模型 ' + models[m] + ' 失敗，切換備援模型...');
        break; // 跳出內層，試下一個模型
      }
      Logger.log('重試中... 錯誤原因: ' + err.toString());
      Utilities.sleep(sleepTime);
    }
  }
  } // 外層模型迴圈結束
  throw new Error('❌ 所有模型均失敗，請稍後再試。');
}


// ── 5. 解析 Claude 輸出的六大區塊 ────────────────────────────

function parseBlocks(text) {
  var blocks = {};
  var blockNums = [1,2,3,4,5,6];
  blockNums.forEach(function(n) {
    var tag   = '[BLOCK' + n + ']';
    var next  = '[BLOCK' + (n + 1) + ']';
    var start = text.indexOf(tag);
    if (start === -1) { blocks['b' + n] = ''; return; }
    start += tag.length;
    var end = text.indexOf(next);
    blocks['b' + n] = (end === -1 ? text.substring(start) : text.substring(start, end)).trim();
  });
  return blocks;
}

// ── 6. 生成 PDF 報告 ─────────────────────────────────────────
// Google Doc 模板需包含以下 {{變數}} 佔位符：
//   {{CLIENT_EMAIL}} {{REPORT_DATE}} {{PRODUCT_PRICE}} {{PRODUCT_CATEGORY}}
//   {{STEEL_COST}} {{WEIGHT_PCT}} {{OLD_TARIFF}} {{NEW_TARIFF}}
//   {{DIFF_AMT}} {{DIFF_PCT}} {{MARGIN_PCT}} {{SCEN_A_MARGIN}}
//   {{SCEN_B_PRICE}} {{WEIGHT_EXEMPT}} {{PAIN_POINT}}
//   {{BLOCK1}} {{BLOCK2}} {{BLOCK3}} {{BLOCK4}} {{BLOCK5}} {{BLOCK6}}
//   {{OFFICIAL_SOURCES}}

function generateReport(data, claudeText) {
  try {
    var templateId = PropertiesService.getScriptProperties().getProperty('TEMPLATE_DOC_ID');
    if (!templateId) { Logger.log('TEMPLATE_DOC_ID not set, skip PDF'); return null; }

    var blocks = parseBlocks(claudeText);
    var dateStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd');

    var copy = DriveApp.getFileById(templateId).makeCopy(
      '232關稅策略報告_' + data.email + '_' +
      Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd')
    );
    var doc  = DocumentApp.openById(copy.getId());
    var body = doc.getBody();

    var replacements = {
      '{{CLIENT_EMAIL}}':    data.email,
      '{{REPORT_DATE}}':     dateStr,
      '{{PRODUCT_PRICE}}':   '$' + data.product_price + ' USD',
      '{{PRODUCT_CATEGORY}}': data.product_category,
      '{{STEEL_COST}}':      '$' + data.steel_cost + ' USD',
      '{{WEIGHT_PCT}}':      data.weight_pct + '%',
      '{{OLD_TARIFF}}':      '$' + data.old_tariff,
      '{{NEW_TARIFF}}':      '$' + data.new_tariff,
      '{{DIFF_AMT}}':        '$' + data.diff_amt,
      '{{DIFF_PCT}}':        data.diff_pct,
      '{{MARGIN_PCT}}':      data.margin_pct + '%',
      '{{SCEN_A_MARGIN}}':   data.scen_a_margin,
      '{{SCEN_B_PRICE}}':    '$' + data.scen_b_price,
      '{{WEIGHT_EXEMPT}}':   data.weight_exempt,
      '{{PAIN_POINT}}':      PAIN_POINT_MAP[data.challenge] || data.challenge,
      '{{BLOCK1}}':          blocks.b1,
      '{{BLOCK2}}':          blocks.b2,
      '{{BLOCK3}}':          blocks.b3,
      '{{BLOCK4}}':          blocks.b4,
      '{{BLOCK5}}':          blocks.b5,
      '{{BLOCK6}}':          blocks.b6,
      '{{OFFICIAL_SOURCES}}': OFFICIAL_SOURCES.join('\n')
    };

    Object.keys(replacements).forEach(function(key) {
      body.replaceText(key.replace(/[{}]/g, '\\$&'), replacements[key] || '');
    });

    doc.saveAndClose();
    var pdf = copy.getAs('application/pdf');
    pdf.setName('232關稅策略報告_覺心營_' + dateStr.replace(/\//g, '') + '.pdf');
    copy.setTrashed(true);
    return pdf;

  } catch (err) {
    Logger.log('generateReport error: ' + err.toString());
    return null;
  }
}

// ── 7. Markdown 渲染（將 Gemini 輸出轉為精緻 HTML）──────────

function renderMarkdown(text) {
  if (!text) return '';
  // 粗體 **text** → <strong>
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  var lines = text.split('\n');
  var html = '';
  var inList = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    if (trimmed === '') {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div style="height:10px;"></div>';
      continue;
    }
    // 編號項目：1. / 2. 等
    if (/^\d+[\.\、]\s/.test(trimmed)) {
      if (inList) { html += '</ul>'; inList = false; }
      var numMatch = trimmed.match(/^(\d+[\.\、])\s(.*)/);
      html += '<div style="margin:0 0 12px;display:flex;gap:8px;">' +
        '<span style="font-weight:700;color:#FF7200;min-width:20px;flex-shrink:0;">' + numMatch[1] + '</span>' +
        '<span>' + numMatch[2] + '</span></div>';
      continue;
    }
    // 子項目：* 或 - 開頭
    if (/^[\*\-]\s/.test(trimmed)) {
      if (!inList) { html += '<ul style="margin:4px 0 10px;padding-left:20px;">'; inList = true; }
      html += '<li style="margin-bottom:8px;line-height:1.8;">' + trimmed.replace(/^[\*\-]\s/, '') + '</li>';
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p style="margin:0 0 10px;line-height:1.85;">' + trimmed + '</p>';
  }
  if (inList) html += '</ul>';
  return html;
}

// ── 8. Email HTML（六大區塊完整版）─────────────────────────

function buildEmailHtml(data, claudeText) {
  var blocks  = parseBlocks(claudeText);
  var dateStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd');
  var isLoss  = parseFloat(data.scen_a_margin) < 0;

  function section(title, content, accent) {
    return (
      '<div style="background:#fff;border-radius:10px;padding:24px 24px 16px;margin-bottom:16px;border:1px solid #e8e0d8;">' +
      '<p style="font-size:11px;font-weight:700;color:' + (accent || '#FF7200') +
      ';text-transform:uppercase;letter-spacing:2px;margin:0 0 14px;">' + title + '</p>' +
      '<div style="font-size:15px;color:#1a1a2e;">' + renderMarkdown(content) + '</div>' +
      '</div>'
    );
  }

  var html =
    '<div style="font-family:\'Noto Sans TC\',Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e;">' +

    // 頂部漸層條
    '<div style="height:5px;background:linear-gradient(135deg,#FFD600,#FF7200,#E84000);border-radius:12px 12px 0 0;"></div>' +
    '<div style="background:#f9f9f7;border:1px solid #e8e0d8;border-top:none;border-radius:0 0 12px 12px;padding:36px;">' +

    // LOGO + 封面
    '<div style="margin-bottom:20px;">' +
    '<img src="https://impact-trade-ai.pages.dev/ahbase-logo.png" alt="覺心營" style="height:48px;width:auto;display:block;">' +
    '</div>' +
    '<h1 style="font-size:20px;font-weight:700;color:#1a1a2e;margin:0 0 4px;">2026 美國 232 條款關稅衝擊與轉型策略分析報告</h1>' +
    '<p style="color:#6b6b80;font-size:12px;margin:0 0 28px;">由 Jessie Chang · 覺心營 為你個人化準備 · ' + dateStr + '</p>' +

    // 數據摘要卡
    '<div style="background:#fff;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid #e8e0d8;">' +
    '<p style="font-size:11px;font-weight:700;color:#FF7200;text-transform:uppercase;letter-spacing:2px;margin:0 0 12px;">關稅衝擊數據</p>' +
    '<table style="width:100%;font-size:14px;border-collapse:collapse;">' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">產品售價</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;">$' + data.product_price + ' USD</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">鋼鋁材料成本</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;">$' + data.steel_cost + ' USD</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">舊制關稅</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;">$' + data.old_tariff + '</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">新制關稅</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;color:#E84000;font-weight:700;">$' + data.new_tariff + '</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">關稅增幅</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;color:#E84000;">+ $' + data.diff_amt + '（' + data.diff_pct + '）</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">情境A 自行吸收稅後毛利</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;color:' + (isLoss ? '#E84000' : '#16a34a') + ';font-weight:700;">' + data.scen_a_margin + '</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;">情境B 建議新報價</td>' +
    '<td style="text-align:right;padding:6px 0;font-weight:700;">$' + data.scen_b_price + '</td></tr>' +
    '</table></div>' +

    // 虧損警告
    (isLoss
      ? '<div style="background:rgba(232,64,0,0.08);border:1px solid rgba(232,64,0,0.3);border-radius:10px;padding:16px;margin-bottom:16px;">' +
        '<p style="margin:0;font-weight:700;color:#E84000;">⚠ 警告：自行吸收關稅將導致虧損（' + data.scen_a_margin + '）</p>' +
        '<p style="margin:4px 0 0;font-size:13px;color:#6b6b80;">強烈建議優先評估部分或全額轉嫁策略。</p></div>'
      : '') +

    // 六大區塊
    section('一、執行摘要', blocks.b1 || '（AI 生成中）') +
    section('二、政策現實確認', blocks.b2 || '（AI 生成中）', '#6b6b80') +
    section('三、利潤壓力分析', blocks.b3 || '（AI 生成中）', isLoss ? '#E84000' : '#FF7200') +
    section('四、談判話術（立即可用）', blocks.b4 || '（AI 生成中）') +
    section('五、30 天行動計劃', blocks.b5 || '（AI 生成中）') +
    section('六、覺心營的下一步', blocks.b6 || '（AI 生成中）', '#C9A84C') +

    // 官方資料來源
    '<div style="background:#f0f0f8;border-radius:10px;padding:16px;margin-bottom:20px;">' +
    '<p style="font-size:11px;font-weight:700;color:#6b6b80;text-transform:uppercase;letter-spacing:2px;margin:0 0 8px;">資料來源（官方）</p>' +
    '<ul style="margin:0;padding-left:18px;font-size:12px;color:#6b6b80;line-height:2;">' +
    OFFICIAL_SOURCES.map(function(s) { return '<li>' + s + '</li>'; }).join('') +
    '</ul></div>' +

    // CTA 按鈕
    '<a href="https://calendar.app.google/yz9edJxyySbihWEy6" ' +
    'style="display:block;background:linear-gradient(135deg,#FFD600,#FF7200,#E84000);color:#fff;' +
    'text-align:center;padding:16px;border-radius:999px;text-decoration:none;font-weight:700;' +
    'font-size:15px;letter-spacing:1px;margin-bottom:8px;">預約免費 三十分鐘關稅衝擊諮詢 →</a>' +
    '<p style="text-align:center;font-size:12px;color:#a0a0b8;margin:0 0 24px;">' +
    'UNDP SDG Impact Standard 認證講師｜劍橋大學 永續領導力碩士班｜Asia Impact Nexus 台灣負責人</p>' +

    '<p style="font-size:11px;color:#a0a0b8;text-align:center;margin:0;">' +
    '© 2026 覺心營股份有限公司 · Jessie Chang · jessie@ahbase.com<br>' +
    '本報告僅供參考，實際稅額以正式報關內容及 CBP 裁定為準。<br>' +
    '如不希望收到此報告，請回信告知。' +
    '</p>' +
    '</div></div>';

  return html;
}

// ── 工具函數 ─────────────────────────────────────────────────

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function cleanupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'sendDelayedReport') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ── 測試函數（開發用）────────────────────────────────────────

// 測試資料（對應 BDD 情境一：售價$100，鋼鋁$30，Annex I-B，重量25%）
var TEST_DATA = {
  email:            'jessie@ahbase.com',  // 改成你的 email 看實際收到的報告
  challenge:        'B',
  product_price:    '100',
  product_category: 'Annex I-B（鋼衍生 25%）',
  steel_cost:       '30',
  weight_pct:       '25',
  old_tariff:       '7.50',
  new_tariff:       '25.00',
  diff_amt:         '17.50',
  diff_pct:         '較舊制增加 233%',
  margin_pct:       '20',
  scen_a_margin:    '-5.0%',
  scen_b_price:     '125.00',
  weight_exempt:    '不符合'
};

// ★ 步驟一：先跑這個，在 Execution Log 看 Prompt 內容，確認無誤再往下
function step1_checkPrompt() {
  var prompt = buildPrompt(TEST_DATA);
  Logger.log('=== SYSTEM PROMPT ===');
  Logger.log(prompt.system);
  Logger.log('\n=== USER PROMPT ===');
  Logger.log(prompt.user);
  Logger.log('\n（確認 Prompt 正確後，執行 step2_checkGeminiOutput）');
}

// ★ 步驟二：呼叫 Gemini，在 Execution Log 看六大區塊輸出，確認品質
function step2_checkGeminiOutput() {
  var report = callGeminiAPI(TEST_DATA);
  Logger.log('=== GEMINI OUTPUT ===');
  Logger.log(report);
  Logger.log('\n（確認內容正確後，執行 step3_sendTestEmail）');
}

// ★ 步驟三：實際寄一封測試報告到你的 email，確認排版與內容
function step3_sendTestEmail() {
  var report = callGeminiAPI(TEST_DATA);
  var blocks = parseBlocks(report);

  // 品質檢查：區塊不足就停止，不寄爛報告
  if (!validateReport(blocks)) {
    Logger.log('❌ 品質不合格，停止寄送。Gemini 原始輸出：\n' + report);
    return;
  }

  var pdfBlob = generateReport(TEST_DATA, report);
  var mailOpts = {
    htmlBody: buildEmailHtml(TEST_DATA, report),
    name:     'Jessie Chang · 覺心營',
    replyTo:  'jessie@ahbase.com'
  };
  if (pdfBlob) mailOpts.attachments = [pdfBlob];

  GmailApp.sendEmail(
    TEST_DATA.email,
    '【測試】232 關稅報告 — 請確認內容',
    '請以 HTML 格式查看此郵件。',
    mailOpts
  );
  Logger.log('✅ 測試 email 已寄出至 ' + TEST_DATA.email);
  Logger.log('（確認 email 無誤後，即可部署 Webhook 正式上線）');
}

// 完整流程測試（含 Sheet 記錄）
function testDoPost() {
  appendToSheet(TEST_DATA);
  var report  = callGeminiAPI(TEST_DATA);
  Logger.log('=== Gemini Report ===');
  Logger.log(report);

  var html = buildEmailHtml(TEST_DATA, report);
  Logger.log('=== Email HTML length: ' + html.length + ' chars ===');

  var pdfBlob = generateReport(TEST_DATA, report);
  Logger.log('PDF: ' + (pdfBlob ? 'generated' : 'skipped (no template)'));
}

function testSendReport() {
  sendDelayedReport();
}


function debugGemini() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  var r = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=' + apiKey,
    {
      method: 'post',
      headers: {'Content-Type': 'application/json'},
      payload: JSON.stringify({contents:[{parts:[{text:'hello'}]}]}),
      muteHttpExceptions: true
    }
  );
  Logger.log('Status: ' + r.getResponseCode());
  Logger.log(r.getContentText().substring(0, 500));
}

function checkAvailableModels() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  var url = 'https://generativelanguage.googleapis.com/v1/models?key=' + apiKey;
  
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var json = JSON.parse(response.getContentText());
    
    if (json.models) {
      var modelList = json.models.map(function(m) { return m.name; });
      Logger.log('✅ 你的 Key 支援的模型有：\n' + modelList.join('\n'));
    } else {
      Logger.log('❌ 無法取得模型清單，錯誤訊息：' + response.getContentText());
    }
  } catch (e) {
    Logger.log('❌ 發生連線錯誤：' + e.toString());
  }
}

// ════════════════════════════════════════════════════════════════
// CBAM 碳邊境稅計算器 — 獨立處理流程
// ════════════════════════════════════════════════════════════════

// ── CBAM Sheet 記錄 ─────────────────────────────────────────────
function appendCbamToSheet(data) {
  try {
    var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!sheetId) { Logger.log('SHEET_ID not set, skipping CBAM sheet'); return; }

    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName('CBAM');
    if (!sheet) {
      sheet = ss.insertSheet('CBAM');
      sheet.appendRow([
        '時間戳', 'Email', '挑戰痛點',
        '產品分類', '產品細項', '出口量(噸/年)',
        '碳排強度(tCO2/噸)', 'CBAM成本(EUR)', 'CBAM成本(NTD)'
      ]);
    }
    sheet.appendRow([
      Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss'),
      data.email, data.challenge,
      data.productCategory, data.productSub,
      data.volume, data.intensity,
      data.cbamEur, data.cbamNtd
    ]);
  } catch (err) {
    Logger.log('appendCbamToSheet error: ' + err.toString());
  }
}

// ── CBAM Gemini Prompt ──────────────────────────────────────────
function buildCbamPrompt(data) {
  var systemPrompt =
    '你是覺心營執行長 Jessie Chang（劍橋大學 CISL 永續領導力碩士、UNDP SDG Impact Standard 認證講師）的顧問助理。\n' +
    '請以 ESG 策略顧問的專業口吻，用繁體中文撰寫台灣企業主可直接使用的 CBAM 因應報告。\n\n' +
    '【語言與語氣規則——違反即重寫】\n' +
    '1. 禁止 AI 腔調：不得出現「值得注意的是」「需要指出的是」「綜上所述」「此外」「總體而言」「不容忽視」等套語\n' +
    '2. 必須使用台灣繁體中文用詞，禁止中國大陸用詞：\n' +
    '   - 軟體（非「软件」）、網路（非「网络」）、資訊（非「信息」）、供應商（非「供应商」）\n' +
    '   - 採購（非「采购」）、報價（非「报价」）、認證（非「认证」）\n' +
    '3. 語氣：直接、精準——像頂尖 ESG 顧問對董事會說話，不像泛用報告\n' +
    '4. 所有建議策略，必須基於真實的 CBAM 法規實務（Regulation EU 2023/956）和國際碳市場機制，不可自行捏造\n\n' +
    '【事實規則】\n' +
    '5. 基於已生效的歐盟法規（Regulation EU 2023/956），不得推測或捏造\n' +
    '6. CBAM 過渡期 2023-2025 只需申報，2026/10/1 起正式繳費\n' +
    '7. 台灣企業需透過歐盟進口商（CBAM 申報義務人）間接面對 CBAM\n' +
    '8. 數字必須與企業資料完全一致';

  var userPrompt =
    '【格式強制規則 — 最高優先，不得違反】\n' +
    '1. 輸出必須且只能包含 [BLOCK1] 至 [BLOCK6] 共六個區塊\n' +
    '2. 每個區塊以 [BLOCK1]、[BLOCK2]...標籤開頭（方括號，大寫，無空格）\n' +
    '3. 禁止輸出任何報告標題、前言、問候語、介紹文字\n' +
    '4. 第一個字必須是 [BLOCK1]\n\n' +

    '請為以下台灣出口企業生成 CBAM 六大區塊報告：\n\n' +
    '【企業 CBAM 計算資料】\n' +
    '- 產品分類：' + data.productCategory + '\n' +
    '- 產品細項：' + data.productSub + '\n' +
    '- 年出口量至歐盟：' + data.volume + ' 噸\n' +
    '- 碳排放強度：' + data.intensity + ' tCO2/噸\n' +
    '- 預估年度 CBAM 成本：€' + data.cbamEur + '（約 NTD ' + data.cbamNtd + '）\n' +
    '- 主要挑戰：' + data.challenge + '\n\n' +

    '[BLOCK1] 執行摘要\n' +
    '直接點出財務衝擊：年度 CBAM 碳費是多少、相當於每噸產品增加多少成本。\n\n' +

    '[BLOCK2] CBAM 政策架構與台灣現況\n' +
    '說明三件事：\n' +
    '① 什麼是 CBAM（歐盟碳邊境調整機制），2026/10/1 起正式繳費\n' +
    '② 台灣企業的直接義務：由歐盟進口商申報，但成本壓力會轉嫁回台灣供應商\n' +
    '③ 台灣碳費（2024/1 生效）與 CBAM 的關係：台灣碳費可部分抵扣 CBAM\n\n' +

    '[BLOCK3] 碳排放競爭力分析\n' +
    '分析此企業的碳排強度（' + data.intensity + ' tCO2/噸）vs 歐盟同類產品基準值（請使用已知的行業數據）。\n' +
    '說明差距對 CBAM 成本的影響，以及減排每降低 1 tCO2/噸可省多少碳費。\n\n' +

    '[BLOCK4] 三大立即應對策略\n' +
    '針對挑戰「' + data.challenge + '」，提供三個策略，每個包含：策略名稱、核心做法、預期效益。\n' +
    '策略方向：碳排放管理（取得碳排強度官方認證）、與歐盟買家談判（碳費分攤）、供應鏈低碳轉型（長期）。\n\n' +

    '[BLOCK5] 30 天立即行動計劃\n' +
    '三個具體行動（含行動名稱、步驟、預期效果）：\n' +
    '1. 取得產品碳排放強度認證（向歐盟進口商提供）\n' +
    '2. 主動與歐盟買家溝通 CBAM 成本分攤方案\n' +
    '3. 了解台灣碳費申報是否可作為 CBAM 抵扣\n\n' +

    '[BLOCK6] 覺心營 ESG 顧問服務\n' +
    '說明面對 CBAM，企業需要系統性 ESG 策略，不只是計算碳費。\n' +
    '帶出 Jessie Chang 的背景（UNDP SDG Impact Standard 認證講師、劍橋大學 CISL 永續領導力碩士、Asia Impact Nexus 台灣負責人）。\n' +
    '提供三個層次的服務（輕/中/重），並附上諮詢邀請。';

  return { system: systemPrompt, user: userPrompt };
}

// ── CBAM 報告生成與寄信 ─────────────────────────────────────────
function processCbamReport(data) {
  try {
    var prompt = buildCbamPrompt(data);
    var fullPrompt = prompt.system + '\n\n---\n\n' + prompt.user;

    var maxRetries = 3;
    var models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-001'];
    var report = null;

    for (var m = 0; m < models.length; m++) {
      for (var i = 0; i < maxRetries; i++) {
        try {
          var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
          var response = UrlFetchApp.fetch(
            'https://generativelanguage.googleapis.com/v1/models/' + models[m] + ':generateContent?key=' + apiKey,
            {
              method: 'post',
              headers: { 'Content-Type': 'application/json' },
              payload: JSON.stringify({
                contents: [{ parts: [{ text: fullPrompt }] }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }
              }),
              muteHttpExceptions: true
            }
          );
          var code = response.getResponseCode();
          if (code === 429 || code === 503) {
            Logger.log('CBAM ⚠️ ' + models[m] + ' ' + code + '，重試 ' + (i+1));
            Utilities.sleep(2000 * (i + 1));
            continue;
          }
          var result = JSON.parse(response.getContentText());
          if (result.error) throw new Error(result.error.message);
          if (result.candidates && result.candidates[0].content) {
            report = result.candidates[0].content.parts[0].text;
            Logger.log('CBAM ✅ 模型 ' + models[m] + ' 成功，輸出前100字：' + report.substring(0, 100));
            break;
          }
        } catch (err) {
          if (i === maxRetries - 1) { Logger.log('CBAM 模型 ' + models[m] + ' 失敗'); break; }
          Utilities.sleep(2000);
        }
      }
      if (report) break;
    }

    if (!report) throw new Error('所有模型均失敗');

    var blocks = parseBlocks(report);
    if (!validateReport(blocks)) {
      Logger.log('⚠️ CBAM 報告品質不合格，通知 Jessie');
      GmailApp.sendEmail('jessie@ahbase.com',
        '【⚠️ CBAM 報告品質不合格】' + data.email, '',
        { htmlBody: '<p style="color:#E84000;font-weight:bold;">CBAM 報告未達標，請手動處理。</p>' +
          '<p><b>客戶：</b>' + data.email + '</p>' +
          '<p><b>產品：</b>' + data.productCategory + ' / ' + data.productSub + '</p>' +
          '<pre style="background:#f5f5f5;padding:12px;font-size:12px;">' + (report || '空白') + '</pre>',
          name: 'Impact Trade AI 系統', replyTo: 'jessie@ahbase.com' });
      return;
    }

    GmailApp.sendEmail(
      data.email,
      '【覺心營】你的 CBAM 碳邊境稅衝擊與 ESG 應對報告',
      '請以 HTML 格式查看此郵件。',
      {
        htmlBody: buildCbamEmailHtml(data, report),
        name: 'Jessie Chang · 覺心營',
        replyTo: 'jessie@ahbase.com'
      }
    );
    Logger.log('✅ CBAM 報告已寄出至：' + data.email);

  } catch (err) {
    Logger.log('processCbamReport error: ' + err.toString());
    try {
      GmailApp.sendEmail('jessie@ahbase.com',
        '【⚠️ CBAM 系統錯誤】' + data.email, '',
        { htmlBody: '<p style="color:#E84000;font-weight:bold;">CBAM 報告生成失敗。</p>' +
          '<p><b>客戶：</b>' + data.email + '</p><p><b>錯誤：</b>' + err.toString() + '</p>',
          name: 'Impact Trade AI 系統', replyTo: 'jessie@ahbase.com' });
    } catch(e) {}
  }
}

// ── CBAM Email HTML ─────────────────────────────────────────────
function buildCbamEmailHtml(data, claudeText) {
  var blocks = parseBlocks(claudeText);
  var dateStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd');

  function section(title, content, color) {
    return (
      '<div style="background:#fff;border-radius:10px;padding:24px 24px 16px;margin-bottom:16px;border:1px solid #e8e0d8;">' +
      '<p style="font-size:11px;font-weight:700;color:' + (color || '#3B7DD8') + ';text-transform:uppercase;letter-spacing:2px;margin:0 0 14px;">' + title + '</p>' +
      '<div style="font-size:15px;color:#1a1a2e;">' + renderMarkdown(content) + '</div>' +
      '</div>'
    );
  }

  return (
    '<div style="font-family:\'Noto Sans TC\',Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e;">' +
    '<div style="height:5px;background:linear-gradient(135deg,#3B7DD8,#6E5AF0);border-radius:12px 12px 0 0;"></div>' +
    '<div style="background:#f9f9f7;border:1px solid #e8e0d8;border-top:none;border-radius:0 0 12px 12px;padding:36px;">' +

    '<div style="margin-bottom:20px;">' +
    '<img src="https://impact-trade-ai.pages.dev/ahbase-logo.png" alt="覺心營" style="height:48px;width:auto;display:block;">' +
    '</div>' +
    '<h1 style="font-size:20px;font-weight:700;color:#1a1a2e;margin:0 0 4px;">CBAM 碳邊境稅衝擊與 ESG 應對策略報告</h1>' +
    '<p style="color:#6b6b80;font-size:12px;margin:0 0 28px;">由 Jessie Chang · 覺心營 為你個人化準備 · ' + dateStr + '</p>' +

    '<div style="background:#fff;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid #e8e0d8;">' +
    '<p style="font-size:11px;font-weight:700;color:#3B7DD8;text-transform:uppercase;letter-spacing:2px;margin:0 0 12px;">CBAM 成本數據</p>' +
    '<table style="width:100%;font-size:14px;border-collapse:collapse;">' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">產品分類</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;">' + data.productCategory + '</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">年出口量</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;">' + data.volume + ' 噸</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">碳排放強度</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;">' + data.intensity + ' tCO₂/噸</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;border-bottom:1px solid #f0ece8;">預估年度 CBAM 成本</td>' +
    '<td style="text-align:right;padding:6px 0;border-bottom:1px solid #f0ece8;color:#3B7DD8;font-weight:700;">€' + data.cbamEur + '</td></tr>' +
    '<tr><td style="color:#6b6b80;padding:6px 0;">折合新台幣</td>' +
    '<td style="text-align:right;padding:6px 0;font-weight:700;">NTD ' + data.cbamNtd + '</td></tr>' +
    '</table></div>' +

    section('一、執行摘要', blocks.b1 || '') +
    section('二、CBAM 政策架構與台灣現況', blocks.b2 || '', '#6E5AF0') +
    section('三、碳排放競爭力分析', blocks.b3 || '', '#3B7DD8') +
    section('四、三大立即應對策略', blocks.b4 || '') +
    section('五、30 天行動計劃', blocks.b5 || '') +
    section('六、覺心營 ESG 顧問服務', blocks.b6 || '', '#C9A84C') +

    '<a href="https://calendar.app.google/yz9edJxyySbihWEy6" ' +
    'style="display:block;background:linear-gradient(135deg,#3B7DD8,#6E5AF0);color:#fff;' +
    'text-align:center;padding:16px;border-radius:999px;text-decoration:none;font-weight:700;' +
    'font-size:15px;letter-spacing:1px;margin-bottom:8px;">預約免費 ESG 策略諮詢 →</a>' +
    '<p style="text-align:center;font-size:12px;color:#a0a0b8;margin:0 0 24px;">' +
    'UNDP SDG Impact Standard 認證講師｜劍橋大學 永續領導力碩士班｜Asia Impact Nexus 台灣負責人</p>' +

    '<p style="font-size:11px;color:#a0a0b8;text-align:center;margin:0;">' +
    '© 2026 覺心營股份有限公司 · Jessie Chang · jessie@ahbase.com<br>' +
    '本報告僅供參考，實際 CBAM 成本以歐盟官方 CBAM 登記系統及進口商申報為準。' +
    '</p>' +
    '</div></div>'
  );
}

// ── CBAM 測試資料與測試函數 ──────────────────────────────────────
var CBAM_TEST_DATA = {
  email:           'jessie@ahbase.com',
  challenge:       '歐盟買家詢問碳費如何分攤',
  productCategory: '鋼鐵（Steel）',
  productSub:      '熱軋鋼板',
  volume:          '500',
  intensity:       '1.8',
  cbamEur:         '4500',
  cbamNtd:         '162000'
};

function step_cbam_test() {
  appendCbamToSheet(CBAM_TEST_DATA);
  Logger.log('CBAM Sheet 記錄完成');
  processCbamReport(CBAM_TEST_DATA);
  Logger.log('CBAM 測試完成，請查收 email');
}

// 補發 lyipei@gmail.com 的報告（扣件 Fasteners CN 7318）
function resend_lyipei_cbam() {
  var data = {
    email:           'lyipei@gmail.com',
    challenge:       '歐盟買家詢問碳費如何分攤',
    productCategory: '扣件 Fasteners（CN 7318）',
    productSub:      '台灣鋼製扣件（螺絲/螺栓/螺帽）',
    volume:          '300',
    intensity:       '1.85',
    cbamEur:         '37,185',
    cbamNtd:         '1,264,290'
  };
  processCbamReport(data);
  Logger.log('lyipei 補發完成');
}
