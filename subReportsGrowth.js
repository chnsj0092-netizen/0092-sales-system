/**
 * 模組名稱：subReportsGrowth.js (Slot 3 去年業績解析與成長率/達成率報表運算模組 V2.4)
 * 職責：解析 Slot 3 去年檢討報告表之 12 月工作表，比對 Slot 1 銷貨月份，產出包含 11 列之「成長率與目標達成分析」工作表
 */

import {
  cleanStringVal,
  safeDouble,
  safeRound,
  formatDateStd
} from "./commonUtils.js";

/**
 * 非同步讀取並解析 Slot 3 去年業績報表 Excel 活頁簿 (.xls / .xlsx)
 * @param {File} file - 使用者上傳之去年業績報表檔案物件
 * @returns {Promise<{sheetName: string, matrix: any[][]}>} 12月工作表名稱與二維陣列資料
 */
export async function parseHistoricalExcelFile(file) {
  if (typeof XLSX === "undefined") {
    throw new Error("SheetJS 元件尚未載入完成，無法解析 Excel 檔案。");
  }
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: "array" });

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error("去年業績報表無任何工作表。");
  }

  // 尋找名稱以 "12" 結尾的工作表（如 202412、202512）
  const decSheets = workbook.SheetNames.filter(name => cleanStringVal(name).endsWith("12"));
  const targetSheetName = decSheets.length > 0
    ? decSheets[decSheets.length - 1]
    : workbook.SheetNames[workbook.SheetNames.length - 1];

  const worksheet = workbook.Sheets[targetSheetName];
  const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });

  if (!matrix || matrix.length === 0) {
    throw new Error(`工作表【${targetSheetName}】內容為空白。`);
  }

  return {
    sheetName: targetSheetName,
    matrix
  };
}

/**
 * 從 S1_RAW 門銷原始報表自動探測銷貨月份 (1 ~ 12)
 * @param {any[][]} s1RawMatrix - S1_RAW 門銷原始報表二維陣列
 * @returns {number} 銷貨月份整數 (1~12)
 */
function detectSalesMonthFromS1Raw(s1RawMatrix) {
  if (!s1RawMatrix || s1RawMatrix.length < 2) {
    throw new Error("門銷原始報表無有效明細，無法判定銷貨月份。");
  }
  const headers = s1RawMatrix[0].map(h => cleanStringVal(h));
  const dateColIdx = headers.findIndex(h => h === "銷貨日期" || h === "建檔日期");
  if (dateColIdx < 0) {
    throw new Error("門銷原始報表缺少「銷貨日期」欄位，無法比對月份。");
  }

  // 掃描明細列，取得第一個有效日期之月份
  for (let r = 1; r < s1RawMatrix.length; r++) {
    const rawDate = formatDateStd(s1RawMatrix[r][dateColIdx]);
    if (rawDate !== "") {
      const match = rawDate.match(/^\d{4}\/(\d{1,2})\//);
      if (match) {
        const monthNum = parseInt(match[1], 10);
        if (monthNum >= 1 && monthNum <= 12) {
          return monthNum;
        }
      }
    }
  }
  throw new Error("無法從門銷原始報表之銷貨日期解析出有效月份 (1~12)。");
}

/**
 * 從 Slot 3 的 12 月工作表二維矩陣中，提取指定月份之七大分類「今年」業績數值
 * @param {any[][]} slot3Matrix - Slot 3 的 12 月工作表二維陣列
 * @param {number} targetMonth - 欲提取之目標月份 (1~12)
 * @returns {Map<string, number>} 七大品類對應之去年同期業績 Map
 */
function extractLastYearStatsFromSlot3(slot3Matrix, targetMonth) {
  const categories = ["框片", "長戴", "OK LENS", "視控鏡片", "視控日拋", "藥拋", "金三明"];
  const lastYearMap = new Map();
  categories.forEach(c => lastYearMap.set(c, 0));

  // 1. 定位「業績」月份標題列與目標月份所在欄位索引
  let monthHeaderRowIdx = -1;
  let monthColIdx = -1;

  for (let r = 0; r < Math.min(slot3Matrix.length, 25); r++) {
    const row = slot3Matrix[r];
    if (!row) continue;
    const firstCell = cleanStringVal(row[0]);
    if (firstCell === "業績") {
      monthHeaderRowIdx = r;
      for (let c = 1; c < row.length; c++) {
        const cellVal = safeDouble(row[c]);
        if (cellVal === targetMonth) {
          monthColIdx = c;
          break;
        }
      }
      if (monthColIdx >= 0) break;
    }
  }

  // 備援掃描：若無「業績」關鍵字，掃描同時具有 1~12 連續數字之列
  if (monthColIdx < 0) {
    for (let r = 0; r < Math.min(slot3Matrix.length, 25); r++) {
      const row = slot3Matrix[r];
      if (!row) continue;
      let tempColIdx = -1;
      let hitCount = 0;
      for (let c = 1; c < row.length; c++) {
        const val = safeDouble(row[c]);
        if (val >= 1 && val <= 12) hitCount++;
        if (val === targetMonth && tempColIdx < 0) tempColIdx = c;
      }
      if (hitCount >= 6 && tempColIdx >= 0) {
        monthHeaderRowIdx = r;
        monthColIdx = tempColIdx;
        break;
      }
    }
  }

  if (monthColIdx < 0) {
    throw new Error(`在去年業績報表中找不到【${targetMonth}月】對應的欄位。`);
  }

  // 2. 掃描七大品類列位，讀取各品類「今年」列在該月份欄位的數值
  let currentCategory = "";
  const startRow = monthHeaderRowIdx >= 0 ? monthHeaderRowIdx + 1 : 0;

  for (let r = startRow; r < slot3Matrix.length; r++) {
    const row = slot3Matrix[r];
    if (!row) continue;

    const col0 = cleanStringVal(row[0]).toUpperCase();
    const col1 = cleanStringVal(row[1]);

    // 檢查 A 欄是否出現新的大分類名稱
    if (col0 !== "") {
      const matchedCat = categories.find(cat => col0 === cat.toUpperCase() || col0.includes(cat.toUpperCase()));
      if (matchedCat) {
        currentCategory = matchedCat;
      } else if (col0.includes("二、") || col0.includes("當月鏡片") || col0.includes("損益")) {
        // 已進入下方其他表格區塊，停止掃描
        break;
      }
    }

    // 當處於有效分類且 B 欄為「今年」時，擷取目標月份欄位之數值
    if (currentCategory !== "" && col1 === "今年") {
      const rawVal = row[monthColIdx];
      const numVal = safeRound(safeDouble(rawVal), 0);
      lastYearMap.set(currentCategory, numVal);
      currentCategory = ""; // 讀取完畢後重置，避免重複覆寫
    }
  }

  return lastYearMap;
}

/**
 * 從 S1_R6 分類業績報表二維陣列中，提取今年七大品類之「未稅售價」
 * @param {any[][]} s1R6Matrix - S1_R6 分類業績報表二維陣列
 * @returns {Map<string, number>} 今年七大品類未稅金額 Map
 */
function extractThisYearStatsFromS1R6(s1R6Matrix) {
  const categories = ["框片", "長戴", "OK LENS", "視控鏡片", "視控日拋", "藥拋", "金三明"];
  const thisYearMap = new Map();
  categories.forEach(c => thisYearMap.set(c, 0));

  if (!s1R6Matrix || s1R6Matrix.length < 2) {
    return thisYearMap;
  }

  // S1_R6 結構：A欄(0)=分類, B欄(1)=銷售數量, C欄(2)=含稅售價, D欄(3)=未稅售價
  for (let r = 1; r < s1R6Matrix.length; r++) {
    const row = s1R6Matrix[r];
    const catLabel = cleanStringVal(row[0]);
    const untaxedVal = safeRound(safeDouble(row[3]), 0);

    if (catLabel === "框片") {
      thisYearMap.set("框片", untaxedVal);
    } else if (catLabel === "長戴") {
      thisYearMap.set("長戴", untaxedVal);
    } else if (catLabel === "OK LENS") {
      thisYearMap.set("OK LENS", untaxedVal);
    } else if (catLabel.includes("└") && catLabel.includes("視控鏡片")) {
      thisYearMap.set("視控鏡片", untaxedVal);
    } else if (catLabel === "視控日拋") {
      thisYearMap.set("視控日拋", untaxedVal);
    } else if (catLabel === "藥拋") {
      thisYearMap.set("藥拋", untaxedVal);
    } else if (catLabel === "金三明") {
      thisYearMap.set("金三明", untaxedVal);
    }
  }

  return thisYearMap;
}

/**
 * 依據防呆規則計算成長率百分比字串
 * @param {number} lastYearVal - 去年數值
 * @param {number} thisYearVal - 今年數值
 * @returns {string} 格式化後之成長率字串
 */
function formatGrowthRate(lastYearVal, thisYearVal) {
  if (lastYearVal < 0) {
    return "-";
  }
  if (lastYearVal === 0) {
    return thisYearVal > 0 ? "100%" : "0%";
  }
  const rate = ((thisYearVal - lastYearVal) / lastYearVal) * 100;
  return `${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`;
}

/**
 * 依據防呆規則計算達成率百分比字串（以去年同期金額為 100%）
 * @param {number} lastYearVal - 去年數值
 * @param {number} thisYearVal - 今年數值
 * @returns {string} 格式化後之達成率字串
 */
function formatAchieveRate(lastYearVal, thisYearVal) {
  if (lastYearVal < 0) {
    return "-";
  }
  if (lastYearVal === 0) {
    return thisYearVal > 0 ? "100%" : "0%";
  }
  const rate = (thisYearVal / lastYearVal) * 100;
  return `${rate.toFixed(2)}%`;
}

/**
 * 執行成長率與目標達成分析報表運算管線 (共 11 個列位)
 * @param {{sheetName: string, matrix: any[][]}} slot3Data - Slot 3 解析後之 12 月工作表物件
 * @param {any[][]} s1R6Matrix - Slot 1 產出之分類業績報表矩陣
 * @param {any[][]} s1RawMatrix - Slot 1 產出之門銷原始報表矩陣
 * @returns {any[][]} 成長率工作表二維矩陣 (12 列 × 9 欄)
 */
export function runGrowthSubReport(slot3Data, s1R6Matrix, s1RawMatrix) {
  const targetMonth = detectSalesMonthFromS1Raw(s1RawMatrix);
  const lastYearMap = extractLastYearStatsFromSlot3(slot3Data.matrix, targetMonth);
  const thisYearMap = extractThisYearStatsFromS1R6(s1R6Matrix);

  const categoryOrder = ["框片", "長戴", "OK LENS", "視控鏡片", "視控日拋", "藥拋", "金三明"];

  const headers = ["項目", ...categoryOrder, "總計"];
  const rowLastYear = ["去年"];
  const rowThisYear = ["今年"];
  const rowDiffThis = ["  └ 距離目標差額"];
  const rowGrowthRate = ["成長率"];
  const rowAchieveRate = ["達成率"];
  const rowAmt90 = ["90%達成率金額"];
  const rowDiff90 = ["  └ 距離目標差額"];
  const rowAmt110 = ["110%達成率金額"];
  const rowDiff110 = ["  └ 距離目標差額"];
  const rowAmt120 = ["120%達成率金額"];
  const rowDiff120 = ["  └ 距離目標差額"];

  let totalLastYear = 0;
  let totalThisYear = 0;
  let totalDiffThis = 0;
  let totalAmt90 = 0;
  let totalDiff90 = 0;
  let totalAmt110 = 0;
  let totalDiff110 = 0;
  let totalAmt120 = 0;
  let totalDiff120 = 0;

  for (const cat of categoryOrder) {
    const lyVal = safeRound(lastYearMap.get(cat) || 0, 0);
    const tyVal = safeRound(thisYearMap.get(cat) || 0, 0);

    // 核心目標差額計算
    const diffThis = lyVal - tyVal;
    const amt90 = safeRound(lyVal * 0.9, 0);
    const diff90 = amt90 - tyVal;
    const amt110 = safeRound(lyVal * 1.1, 0);
    const diff110 = amt110 - tyVal;
    const amt120 = safeRound(lyVal * 1.2, 0);
    const diff120 = amt120 - tyVal;

    rowLastYear.push(lyVal);
    rowThisYear.push(tyVal);
    rowDiffThis.push(diffThis);
    rowGrowthRate.push(formatGrowthRate(lyVal, tyVal));
    rowAchieveRate.push(formatAchieveRate(lyVal, tyVal));
    rowAmt90.push(amt90);
    rowDiff90.push(diff90);
    rowAmt110.push(amt110);
    rowDiff110.push(diff110);
    rowAmt120.push(amt120);
    rowDiff120.push(diff120);

    totalLastYear += lyVal;
    totalThisYear += tyVal;
    totalDiffThis += diffThis;
    totalAmt90 += amt90;
    totalDiff90 += diff90;
    totalAmt110 += amt110;
    totalDiff110 += diff110;
    totalAmt120 += amt120;
    totalDiff120 += diff120;
  }

  // 寫入 I 欄總計（金額類採代數加總，比率類獨立以總額計算）
  rowLastYear.push(safeRound(totalLastYear, 0));
  rowThisYear.push(safeRound(totalThisYear, 0));
  rowDiffThis.push(safeRound(totalDiffThis, 0));
  rowGrowthRate.push(formatGrowthRate(totalLastYear, totalThisYear));
  rowAchieveRate.push(formatAchieveRate(totalLastYear, totalThisYear));
  rowAmt90.push(safeRound(totalAmt90, 0));
  rowDiff90.push(safeRound(totalDiff90, 0));
  rowAmt110.push(safeRound(totalAmt110, 0));
  rowDiff110.push(safeRound(totalDiff110, 0));
  rowAmt120.push(safeRound(totalAmt120, 0));
  rowDiff120.push(safeRound(totalDiff120, 0));

  return [
    headers,
    rowLastYear,
    rowThisYear,
    rowDiffThis,
    rowGrowthRate,
    rowAchieveRate,
    rowAmt90,
    rowDiff90,
    rowAmt110,
    rowDiff110,
    rowAmt120,
    rowDiff120
  ];
}