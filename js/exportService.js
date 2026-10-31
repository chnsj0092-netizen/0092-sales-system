/**
 * 模組名稱：exportService.js (報表渲染與 Excel 匯出服務模組)
 * 職責：負責網頁表格 DOM 渲染、條件式高亮格式化，以及呼叫 SheetJS 匯出多分頁 .xlsx 檔案
 */

/** 報表標準排序與中文名稱定義 */
export const REPORT_SEQUENCE = [
  { key: "S1_R1", label: "S1_R1 原始銷售明細" },
  { key: "S1_R2", label: "S1_R2 單據彙整表" },
  { key: "S1_R3", label: "S1_R3 人員績效統計" },
  { key: "S1_R4", label: "S1_R4 品類營收分析" },
  { key: "S1_R5", label: "S1_R5 分類銷售明細" },
  { key: "S1_R6", label: "S1_R6 分類銷售彙整" },
  { key: "S1_R7", label: "S1_R7 分類業績統計" },
  { key: "S2_R1", label: "S2_R1 訂金未取明細表" },
  { key: "S2_R2", label: "S2_R2 未取件列表" },
  { key: "S2_R3", label: "S2_R3 未取訂金品類分析" }
];

/**
 * 判斷表頭欄位是否屬於金額/數量型態（需靠右並千分位格式化）
 * @param {string} colName - 表頭欄位名稱
 * @returns {boolean} 是否為數值金額欄
 */
function isAmountOrQtyColumn(colName) {
  return (
    colName.includes("金額") || colName.includes("小計") ||
    colName.includes("業績") || colName.includes("實收") ||
    colName.includes("訂金") || colName.includes("尾款") ||
    colName.includes("未稅") || colName.includes("折抵") ||
    colName.includes("總額") || colName.includes("實售價") ||
    colName.includes("數量") || colName.includes("件數") ||
    colName.includes("訂單數") || colName.includes("單焦鏡片") ||
    colName.includes("多焦鏡片") || colName.includes("視控鏡片")
  ) && !colName.includes("是否");
}

/**
 * 判斷表頭欄位是否屬於百分比型態
 * @param {string} colName - 表頭欄位名稱
 * @returns {boolean} 是否為百分比欄
 */
function isPercentColumn(colName) {
  return colName.includes("佔比");
}

/**
 * 將單一報表二維矩陣渲染為 HTML 表格字串
 * @param {string} reportKey - 報表代號 (如 "S1_R4", "S2_R2")
 * @param {any[][]} matrix - 報表二維陣列 (含第 0 列標頭)
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

  dataRows.forEach((row, rIdx) => {
    const firstCell = String(row[0] ?? "");
    const isTotalRow = firstCell.includes("總計");

    // 判斷是否為「承件沒有銷售明細」列（S2_R2 第 8 欄或 S2_R3 第 1 欄）
    let isContractRow = false;
    if (reportKey === "S2_R2" && String(row[7] ?? "") === "承件沒有銷售明細") {
      isContractRow = true;
    } else if (reportKey === "S2_R3" && firstCell === "承件沒有銷售明細") {
      isContractRow = true;
    }

    let trClass = "";
    if (isTotalRow) {
      trClass = "total-row";
    } else if (isContractRow) {
      trClass = "highlight-purple";
    }

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

      // 縮排子項目樣式
      if (typeof displayVal === "string" && displayVal.includes("└")) {
        classes.push("sub-item");
      }

      // S2_R1 (欄索引 13) 與 S2_R2 (欄索引 5) 尚欠尾款 > 0 紅字警示
      if (
        !isTotalRow &&
        ((reportKey === "S2_R1" && cIdx === 13) || (reportKey === "S2_R2" && cIdx === 5)) &&
        typeof cell === "number" &&
        cell > 0
      ) {
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
 * @param {Map<string, any[][]>} selectedReportsMap - 已勾選之報表資料 Map
 * @param {boolean} hasS1 - 是否包含 Slot 1
 * @param {boolean} hasS2 - 是否包含 Slot 2
 */
export function exportReportsToExcel(selectedReportsMap, hasS1, hasS2) {
  if (typeof XLSX === "undefined") {
    alert("SheetJS 元件尚未載入完成，請檢查網路連線後重試。");
    return;
  }

  const wb = XLSX.utils.book_new();

  // 嚴格依 V1.5 規格書順序建立分頁
  for (const item of REPORT_SEQUENCE) {
    if (!selectedReportsMap.has(item.key)) continue;

    const matrix = selectedReportsMap.get(item.key);
    const headers = matrix[0] || [];

    // 格式化百分比與文字型態後輸出至 Sheet
    const formattedMatrix = matrix.map((row, rIdx) => {
      if (rIdx === 0) return row;
      return row.map((cell, cIdx) => {
        const colName = String(headers[cIdx] ?? "");
        if (isPercentColumn(colName) && typeof cell === "number") {
          return `${(cell * 100).toFixed(2)}%`;
        }
        return cell;
      });
    });

    const ws = XLSX.utils.aoa_to_sheet(formattedMatrix);

    // 自動計算並設定最佳欄寬
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

    XLSX.utils.book_append_sheet(wb, ws, item.key);
  }

  // 依 V1.5 規格書規則動態命名匯出檔案
  const now = new Date();
  const dateStr =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  let fileName = `南勢角_營運綜合統計報表_${dateStr}.xlsx`;
  if (hasS1 && !hasS2) {
    fileName = `南勢角_門市業績統計報表_${dateStr}.xlsx`;
  } else if (!hasS1 && hasS2) {
    fileName = `南勢角_訂金未取貨統計表_${dateStr}.xlsx`;
  }

  XLSX.writeFile(wb, fileName);
}
