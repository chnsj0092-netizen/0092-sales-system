/**
 * 模組名稱：commonUtils.js (共用工具與底層清洗服務層)
 * 職責：提供 UTF-16 LE 檔案解碼、字串控制碼清洗、數值安全轉換、標準商業四捨五入與表頭驗證
 */

/**
 * 過濾 ERP 匯出檔尾端常見之 \x80 (ASCII 128) 控制碼、Tab、換行與前後空白
 * @param {any} val - 輸入之原始儲存格值或字串
 * @returns {string} 清洗後之純淨字串
 */
export function cleanStringVal(val) {
  if (val === null || val === undefined) {
    return "";
  }
  // 轉為字串處理
  let str = String(val);
  // 清除 \x80 (CharCode 128) 與歐洲貨幣符號 € (部分編碼轉換產物) 及不間斷空白
  str = str.replace(/[\x80\u0080\u20ac\t\r\n\0]/g, "");
  str = str.replace(/\u00a0/g, " ");
  return str.trim();
}

/**
 * 安全將字串或儲存格值轉為雙精度浮點數，自動剔除千分位逗號與貨幣符號
 * @param {any} val - 輸入之數值或字串
 * @returns {number} 轉換後之數值，異常值回傳 0
 */
export function safeDouble(val) {
  if (val === null || val === undefined) {
    return 0;
  }
  if (typeof val === "number" && !Number.isNaN(val)) {
    return val;
  }
  let str = cleanStringVal(val);
  if (str === "" || str === "-") {
    return 0;
  }
  // 剔除千分位逗號與貨幣符號
  str = str.replace(/[,$NT\s]/g, "");
  const parsed = Number(str);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 標準商業四捨五入函式（禁止銀行家捨入法，杜絕發票對帳 1 元差額）
 * @param {number} val - 欲四捨五入之數值
 * @param {number} digits - 保留小數位數（預設為 0 取整數）
 * @returns {number} 四捨五入後之數值
 */
export function safeRound(val, digits = 0) {
  const num = safeDouble(val);
  const factor = Math.pow(10, digits);
  if (num >= 0) {
    return Math.floor(num * factor + 0.5) / factor;
  } else {
    return Math.ceil(num * factor - 0.5) / factor;
  }
}

/**
 * 計算未稅金額（含稅金額 / 1.05 後標準商業四捨五入取整數）
 * @param {number} taxedAmount - 含稅金額
 * @returns {number} 未稅整數金額
 */
export function calcUntaxedAmount(taxedAmount) {
  const amt = safeDouble(taxedAmount);
  if (amt === 0) {
    return 0;
  }
  return safeRound(amt / 1.05, 0);
}

/**
 * 將各類日期字串統一格式化為 YYYY/MM/DD
 * @param {any} dateVal - 原始日期字串
 * @returns {string} 格式化後之 YYYY/MM/DD 字串
 */
export function formatDateStd(dateVal) {
  const str = cleanStringVal(dateVal);
  if (str === "") {
    return "";
  }
  // 處理 8 碼純數字 YYYYMMDD
  if (/^\d{8}$/.test(str)) {
    return `${str.slice(0, 4)}/${str.slice(4, 6)}/${str.slice(6, 8)}`;
  }
  // 處理如 "2026/09/ 1" 或 "2026/7/7" 等含有空白或單碼月日之字串
  const match = str.match(/^(\d{4})[\/\-](\s*\d{1,2})[\/\-](\s*\d{1,2})/);
  if (match) {
    const year = match[1];
    const month = match[2].trim().padStart(2, "0");
    const day = match[3].trim().padStart(2, "0");
    return `${year}/${month}/${day}`;
  }
  return str;
}

/**
 * 針對被吃掉前導零的純數字代碼（如三聯單號12碼、會員編號10碼、項次4碼）自動補齊前導零
 * @param {any} val - 原始代碼字串
 * @param {number} targetLen - 目標碼數長度
 * @returns {string} 補齊前導零後之字串
 */
export function padZeroLeft(val, targetLen) {
  const cleanStr = cleanStringVal(val);
  if (cleanStr === "") {
    return "";
  }
  // 若為純數字且長度小於目標長度，且不為單一 "0"（承件款條碼為單一 "0"）
  if (/^\d+$/.test(cleanStr) && cleanStr.length < targetLen && cleanStr !== "0") {
    return cleanStr.padStart(targetLen, "0");
  }
  return cleanStr;
}

/**
 * 判斷銷售人員工號是否為 E 或 e 開頭
 * @param {string} staffCode - 銷售人員工號字串
 * @returns {boolean} 若為 E/e 開頭回傳 true，否則回傳 false
 */
export function isExcludedStaffE(staffCode) {
  const cleanCode = cleanStringVal(staffCode);
  if (cleanCode === "") {
    return false;
  }
  return /^e/i.test(cleanCode);
}

/**
 * 非同步讀取上傳之來源檔案（自動偵測 UTF-16 LE BOM 或 UTF-8 TSV）並轉為二維陣列
 * @param {File} file - 使用者上傳之檔案物件
 * @returns {Promise<{headers: string[], rows: string[][], colMap: Map<string, number>}>} 解析結果物件
 */
export async function parseSourceFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);

  // 偵測 BOM：若前兩位元組為 0xFF 0xFE 則為 UTF-16 LE
  let encoding = "utf-8";
  if (uint8.length >= 2 && uint8[0] === 0xff && uint8[1] === 0xfe) {
    encoding = "utf-16le";
  } else if (uint8.length >= 2 && uint8[0] === 0xfe && uint8[1] === 0xff) {
    encoding = "utf-16be";
  }

  const decoder = new TextDecoder(encoding);
  const rawText = decoder.decode(arrayBuffer);

  // 依換行符號切分資料列
  const lines = rawText.split(/\r?\n/).filter(line => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("檔案內容為空白，無法解析。");
  }

  // 解析第 1 列標頭，建立欄位名稱對應索引字典 (0-Based)
  const rawHeaders = lines[0].split("\t");
  const headers = rawHeaders.map(h => cleanStringVal(h));
  const colMap = new Map();
  headers.forEach((hName, idx) => {
    if (hName !== "" && !colMap.has(hName)) {
      colMap.set(hName, idx);
    }
  });

  // 解析明細資料列（鎖定標頭欄位寬度，消除末尾冗餘 Tab 位移）
  const maxCols = headers.length;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    const rowArr = [];
    for (let c = 0; c < maxCols; c++) {
      rowArr.push(c < parts.length ? cleanStringVal(parts[c]) : "");
    }
    rows.push(rowArr);
  }

  return { headers, rows, colMap };
}

/**
 * 檢驗欄位映射表是否包含所有必要欄位（支援同義欄位名稱陣列比對）
 * @param {Map<string, number>} colMap - 標頭欄位映射表
 * @param {Array<string|string[]>} reqCols - 必要欄位清單（元素可為單一欄名或同義欄名陣列）
 * @returns {{isValid: boolean, missingMsg: string}} 檢驗結果
 */
export function validateSchema(colMap, reqCols) {
  const missingList = [];
  for (const item of reqCols) {
    if (Array.isArray(item)) {
      // 只要同義欄位其中之一存在即通過
      const found = item.some(alias => colMap.has(alias));
      if (!found) {
        missingList.push(`【${item.join("/")}】`);
      }
    } else {
      if (!colMap.has(item)) {
        missingList.push(`【${item}】`);
      }
    }
  }
  return {
    isValid: missingList.length === 0,
    missingMsg: missingList.join("、")
  };
}
