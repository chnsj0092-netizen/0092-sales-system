/**
 * 模組名稱：exportService.js (報表渲染與 Excel 匯出服務模組 V2.5)
 * 職責：負責網頁表格 DOM 渲染、全域置中/靠右對齊格式化、成長率專屬自訂底色高亮，以及呼叫 SheetJS 匯出多分頁 .xlsx 檔案
 */

/** 報表標準排序與中文名稱定義 (共 7 個標準分頁) */
export const REPORT_SEQUENCE = [
  { key: "S1_RAW", label: "門銷原始報表" },
  { key: "S1_R6", label: "分類業績報表" },
  { key: "S1_STAFF", label: "人員業績統計" },
  { key: "S3_GROWTH", label: "成長率" },
  { key: "S2_RAW", label: "訂金原始報表" },
  { key: "S2_R1", label: "可銷貨名單" },
  { key: "S2_R2", label: "未取件列表" }
];

/**
 * 檢驗是否屬於數值或金額欄位
 * @param {string} colName - 欄位名稱字串
 * @returns {boolean} 是否為金額或數量欄位
 */
function isAmountOrQtyColumn(colName) {
  return (
    colName.includes("金額") || colName.includes("小計") ||
    colName.includes("業績") || colName.includes("實收") ||
    colName.includes("訂金") || colName.includes("尾款") ||
    colName.includes("未稅") || colName.includes("折抵") ||
    colName.includes("總額") || colName.includes("實售價") ||
    colName.includes("數量") || colName.includes("件數") ||
    colName.includes("售價") || colName.includes("總計") ||
    colName.includes("框片") || colName.includes("長戴") ||
    colName.includes("單焦鏡片") || colName.includes("多焦鏡片") || colName.includes("視控鏡片") ||
    colName.includes("OK LENS") || colName.includes("視控日拋") ||
    colName.includes("藥拋") || colName.includes("金三明") ||
    colName.includes("帳務調整與折抵")
  ) && !colName.includes("是否");
}

/**
 * 檢驗是否為百分比欄位
 * @param {string} colName - 欄位名稱字串
 * @returns {boolean} 是否為百分比欄位
 */
function isPercentColumn(colName) {
  return colName.includes("佔比") || colName.includes("成長率") || colName.includes("達成率");
}

/**
 * 將單一報表二維矩陣渲染為 HTML 表格字串
 * 遵循全域排版合約：所有標題欄位(th)及首欄列位(cIdx === 0)統一置中，其餘資料儲存格(td)統一靠右對齊
 * @param {string} reportKey - 報表代號
 * @param {any[][]} matrix - 報表二維矩陣
 * @returns {{html: string, infoText: string}} HTML 字串與資訊列摘要物件
 */
export function renderReportTableHTML(reportKey, matrix) {
  if (!matrix || matrix.length === 0) {
    return { html: "<p style='padding:20px; text-align:center;'>無資料可供顯示</p>", infoText: "0 筆資料" };
  }

  const headers = matrix[0];
  const dataRows = matrix.slice(1);

  let html = "<table><thead><tr>";
  headers.forEach(h => {
    const hStr = String(h ?? "");
    html += `<th class="text-center">${hStr}</th>`;
  });
  html += "</tr></thead><tbody>";

  dataRows.forEach(row => {
    const firstCell = String(row[0] ?? "").trim();
    const isTotalRow = firstCell.includes("總計");
    let isContractRow = false;
    let isLightBlueRow = false;

    // 成長率報表專用自訂底色判定 (V2.5)
    let isGrowthThisYear = false;
    let isGrowthAchieveRate = false;
    let isGrowthAmt90 = false;
    let isGrowthAmt110 = false;
    let isGrowthAmt120 = false;

    if (reportKey === "S3_GROWTH") {
      if (firstCell === "今年") isGrowthThisYear = true;
      else if (firstCell === "達成率") isGrowthAchieveRate = true;
      else if (firstCell === "90%達成率金額") isGrowthAmt90 = true;
      else if (firstCell === "110%達成率金額") isGrowthAmt110 = true;
      else if (firstCell === "120%達成率金額") isGrowthAmt120 = true;
    }

    if (reportKey === "S2_R2" && String(row[7] ?? "") === "承件沒有銷售明細") isContractRow = true;

    // S1_R6 分類業績報表之大類加總底色
    if (reportKey === "S1_R6" && ["框片", "長戴", "OK LENS", "視控日拋", "藥拋", "金三明"].includes(firstCell)) {
      isLightBlueRow = true;
    }

    let trClass = "";
    if (isTotalRow) trClass = "total-row";
    else if (isGrowthThisYear) trClass = "growth-this-year";
    else if (isGrowthAchieveRate) trClass = "growth-achieve-rate";
    else if (isGrowthAmt90) trClass = "growth-amt-90";
    else if (isGrowthAmt110) trClass = "growth-amt-110";
    else if (isGrowthAmt120) trClass = "growth-amt-120";
    else if (isContractRow) trClass = "highlight-purple";
    else if (isLightBlueRow) trClass = "highlight-lightblue";

    html += `<tr class="${trClass}">`;

    row.forEach((cell, cIdx) => {
      const colName = String(headers[cIdx] ?? "");
      let classes = [];
      let displayVal = cell ?? "";

      // 首欄（列位標題）統一設定置中，其餘儲存格資料內容全部靠右對齊
      if (cIdx === 0) {
        classes.push("row-header-cell", "text-center");
      } else {
        classes.push("text-right");
      }

      if (isPercentColumn(colName) && typeof cell === "number") {
        displayVal = `${(cell * 100).toFixed(2)}%`;
      } else if (typeof cell === "number" && (isAmountOrQtyColumn(colName) || reportKey === "S3_GROWTH")) {
        displayVal = cell.toLocaleString("zh-TW");
      }

      if (typeof displayVal === "string" && displayVal.includes("└")) {
        classes.push("sub-item");
      }

      if (!isTotalRow && typeof cell === "number" && cell > 0 &&
         (reportKey === "S2_R2" && cIdx === 5)) {
        classes.push("highlight-unpaid");
      }

      html += `<td class="${classes.join(" ")}">${displayVal}</td>`;
    });
    html += "</tr>";
  });

  html += "</tbody></table>";
  const rowCount = reportKey === "S3_GROWTH" ? dataRows.length : Math.max(0, dataRows.length - 1);
  const infoText = `目前檢視：${reportKey} ｜ 共 ${rowCount} 筆資料列`;
  return { html, infoText };
}

/**
 * 將使用者選取之報表集合匯出為多分頁 .xlsx 活頁簿
 * @param {Map<string, any[][]>} selectedReportsMap - 已勾選之報表映射表
 * @param {boolean} hasS1 - 是否包含 Slot 1 資料
 * @param {boolean} hasS2 - 是否包含 Slot 2 資料
 */
export function exportReportsToExcel(selectedReportsMap, hasS1, hasS2) {
  if (typeof XLSX === "undefined") {
    alert("SheetJS 元件尚未載入完成，請檢查網路連線後重試。");
    return;
  }
  const wb = XLSX.utils.book_new();

  for (const item of REPORT_SEQUENCE) {
    if (!selectedReportsMap.has(item.key)) continue;

    const matrix = selectedReportsMap.get(item.key);
    const headers = matrix[0] || [];

    const formattedMatrix = matrix.map((row, rIdx) => {
      if (rIdx === 0) return row;
      return row.map((cell, cIdx) => {
        const colName = String(headers[cIdx] ?? "");
        if (isPercentColumn(colName) && typeof cell === "number") return `${(cell * 100).toFixed(2)}%`;
        return cell;
      });
    });

    const ws = XLSX.utils.aoa_to_sheet(formattedMatrix);

    const colWidths = headers.map((h, cIdx) => {
      let maxLen = String(h ?? "").length * 2;
      for (let r = 1; r < formattedMatrix.length; r++) {
        const valStr = String(formattedMatrix[r][cIdx] ?? "");
        const len = valStr.length * (/[^\x00-\xff]/.test(valStr) ? 1.8 : 1.1);
        if (len > maxLen) maxLen = len;
      }
      return { wch: Math.min(Math.max(maxLen + 3, 10), 48) };
    });
    ws["!cols"] = colWidths;

    // 工作表標籤命名對應 (V2.5 命名對應)
    let sheetName = item.key;
    if (item.key === "S2_R1") sheetName = "可銷貨名單";
    else if (item.key === "S1_STAFF") sheetName = "人員業績統計";
    else if (item.key === "S3_GROWTH") sheetName = "成長率";
    else if (item.key === "S2_R2") sheetName = "未取件列表";

    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const now = new Date();
  const dateStr = now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
  
  let fileName = `營運綜合統計報表_${dateStr}.xlsx`;
  if (hasS1 && !hasS2) fileName = `門市業績統計報表_${dateStr}.xlsx`;
  else if (!hasS1 && hasS2) fileName = `訂金未取貨統計表_${dateStr}.xlsx`;

  XLSX.writeFile(wb, fileName);
}
