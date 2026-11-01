/**
 * 模組名稱：exportService.js (報表渲染與 Excel 匯出服務模組 V2.1)
 * 職責：負責網頁表格 DOM 渲染、條件式高亮格式化，以及呼叫 SheetJS 匯出多分頁 .xlsx 檔案
 * 備註：依據 V2.1 規範已徹底移除 S1_R4 品類營收分析、S1_R5 分類銷售明細與 S2_R3 未取訂金品類分析
 */

/** 報表標準排序與中文名稱定義 (共 7 個標準分頁) */
export const REPORT_SEQUENCE = [
  { key: "S1_RAW", label: "門銷原始報表" },
  { key: "S1_R1", label: "S1_R1 銷貨明細表" },
  { key: "S1_R3", label: "S1_R3 人員績效統計" },
  { key: "S1_R6", label: "分類業績報表" },
  { key: "S2_RAW", label: "訂金原始報表" },
  { key: "S2_R1", label: "可銷貨名單" },
  { key: "S2_R2", label: "S2_R2 未取件列表" }
];

/**
 * 檢驗是否屬於數值或金額欄位
 * @param {string} colName - 欄位名稱
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
    colName.includes("售價") ||
    colName.includes("單焦鏡片") || colName.includes("多焦鏡片") || colName.includes("視控鏡片")
  ) && !colName.includes("是否");
}

/**
 * 檢驗是否為百分比欄位
 * @param {string} colName - 欄位名稱
 * @returns {boolean} 是否為百分比
 */
function isPercentColumn(colName) {
  return colName.includes("佔比");
}

/**
 * 將單一報表二維矩陣渲染為 HTML 表格字串
 * @param {string} reportKey - 報表代號
 * @param {any[][]} matrix - 報表二維陣列
 * @returns {{html: string, infoText: string}} HTML 字串與資訊列摘要
 */
export function renderReportTableHTML(reportKey, matrix) {
  if (!matrix || matrix.length === 0) {
    return { html: "<p style='padding:20px;'>無資料可供顯示</p>", infoText: "0 筆資料" };
  }

  const headers = matrix[0];
  const dataRows = matrix.slice(1);

  let html = "<table><thead><tr>";
  headers.forEach(h => {
    const hStr = String(h);
    const alignClass = (isAmountOrQtyColumn(hStr) || isPercentColumn(hStr)) ? "text-right" : "";
    html += `<th class="${alignClass}">${hStr}</th>`;
  });
  html += "</tr></thead><tbody>";

  dataRows.forEach(row => {
    const firstCell = String(row[0] ?? "");
    const isTotalRow = firstCell.includes("總計");
    let isContractRow = false;
    let isLightBlueRow = false;

    if (reportKey === "S2_R2" && String(row[7] ?? "") === "承件沒有銷售明細") isContractRow = true;

    // S1_R6 分類業績報表的淺藍底色判定（大類加總項）
    if (reportKey === "S1_R6" && ["框片", "長戴", "OK LENS", "視控日拋", "藥拋", "金三明"].includes(firstCell)) {
      isLightBlueRow = true;
    }

    let trClass = "";
    if (isTotalRow) trClass = "total-row";
    else if (isContractRow) trClass = "highlight-purple";
    else if (isLightBlueRow) trClass = "highlight-lightblue";

    html += `<tr class="${trClass}">`;

    row.forEach((cell, cIdx) => {
      const colName = String(headers[cIdx] ?? "");
      let classes = [];
      let displayVal = cell ?? "";

      if (isPercentColumn(colName) && typeof cell === "number") {
        classes.push("text-right");
        displayVal = `${(cell * 100).toFixed(2)}%`;
      } else if (isAmountOrQtyColumn(colName) && typeof cell === "number") {
        classes.push("text-right");
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
  const infoText = `目前檢視：${reportKey} ｜ 共 ${Math.max(0, dataRows.length - 1)} 筆資料列`;
  return { html, infoText };
}

/**
 * 將使用者選取之報表集合匯出為多分頁 .xlsx 活頁簿
 * @param {Map<string, any[][]>} selectedReportsMap - 已勾選之報表 Map
 * @param {boolean} hasS1 - 是否包含 Slot 1
 * @param {boolean} hasS2 - 是否包含 Slot 2
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
      let maxLen = String(h).length * 2;
      for (let r = 1; r < formattedMatrix.length; r++) {
        const valStr = String(formattedMatrix[r][cIdx] ?? "");
        const len = valStr.length * (/[^\x00-\xff]/.test(valStr) ? 1.8 : 1.1);
        if (len > maxLen) maxLen = len;
      }
      return { wch: Math.min(Math.max(maxLen + 3, 10), 48) };
    });
    ws["!cols"] = colWidths;

    // 工作表標籤命名：若為 S2_R1 則直接命名為「可銷貨名單」
    const sheetName = item.key === "S2_R1" ? "可銷貨名單" : item.key;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const now = new Date();
  const dateStr = now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
  
  let fileName = `營運綜合統計報表_${dateStr}.xlsx`;
  if (hasS1 && !hasS2) fileName = `門市業績統計報表_${dateStr}.xlsx`;
  else if (!hasS1 && hasS2) fileName = `訂金未取貨統計表_${dateStr}.xlsx`;

  XLSX.writeFile(wb, fileName);
}
