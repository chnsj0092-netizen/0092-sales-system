/**
 * 模組名稱：exportService.js (報表渲染與 ExcelJS 匯出服務模組 V2.5.1)
 * 職責：負責網頁表格 DOM 渲染、全域置中/靠右對齊格式化、成長率專屬自訂底色高亮，以及呼叫 ExcelJS 匯出含完整樣式之多分頁 .xlsx 檔案
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

/** 成長率報表各高亮列位之色票與深色文字定義表 (網頁與 Excel 共用基準) */
const GROWTH_ROW_STYLES = {
  "今年": { cssClass: "growth-this-year", bgArgb: "FFFFE6A8", fontArgb: "FF451A03" },
  "達成率": { cssClass: "growth-achieve-rate", bgArgb: "FFBBFF84", fontArgb: "FF14532D" },
  "90%達成率金額": { cssClass: "growth-amt-90", bgArgb: "FF8798FF", fontArgb: "FF1E1B4B" },
  "110%達成率金額": { cssClass: "growth-amt-110", bgArgb: "FFFFABAB", fontArgb: "FF7F1D1D" },
  "120%達成率金額": { cssClass: "growth-amt-120", bgArgb: "FFFF93E9", fontArgb: "FF701A75" }
};

/** S1_R6 分類業績報表需標記淺藍底色之六大主分類清單 */
const S1_R6_MAIN_CATEGORIES = ["框片", "長戴", "OK LENS", "視控日拋", "藥拋", "金三明"];

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
    colName.includes("藥拋") || colName.includes("金三明")
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
    const isContractRow = reportKey === "S2_R2" && String(row[7] ?? "") === "承件沒有銷售明細";
    const isLightBlueRow = reportKey === "S1_R6" && S1_R6_MAIN_CATEGORIES.includes(firstCell);
    const growthStyle = reportKey === "S3_GROWTH" ? GROWTH_ROW_STYLES[firstCell] : null;

    // 決定該資料列之 CSS 樣式類別
    let trClass = "";
    if (isTotalRow) trClass = "total-row";
    else if (growthStyle) trClass = growthStyle.cssClass;
    else if (isContractRow) trClass = "highlight-purple";
    else if (isLightBlueRow) trClass = "highlight-lightblue";

    html += `<tr class="${trClass}">`;

    row.forEach((cell, cIdx) => {
      const colName = String(headers[cIdx] ?? "");
      const classes = [];
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
  const reportMeta = REPORT_SEQUENCE.find(item => item.key === reportKey);
  const displayName = reportMeta ? reportMeta.label : reportKey;
  const infoText = `目前檢視：${displayName} ｜ 共 ${rowCount} 筆資料列`;
  return { html, infoText };
}

/**
 * 取得匯出工作表對應之 Excel 分頁名稱
 * @param {string} reportKey - 報表內部代號
 * @returns {string} Excel 工作表標籤名稱
 */
function getExcelSheetName(reportKey) {
  if (reportKey === "S2_R1") return "可銷貨名單";
  if (reportKey === "S1_STAFF") return "人員業績統計";
  if (reportKey === "S3_GROWTH") return "成長率";
  if (reportKey === "S2_R2") return "未取件列表";
  return reportKey;
}

/**
 * 透過 ExcelJS 將使用者選取之報表集合匯出為含完整底色、框線與對齊樣式之多分頁 .xlsx 活頁簿
 * @param {Map<string, any[][]>} selectedReportsMap - 已勾選之報表映射表
 * @param {boolean} hasS1 - 是否包含 Slot 1 資料
 * @param {boolean} hasS2 - 是否包含 Slot 2 資料
 * @returns {Promise<void>}
 */
export async function exportReportsToExcel(selectedReportsMap, hasS1, hasS2) {
  if (typeof ExcelJS === "undefined") {
    alert("ExcelJS 匯出元件尚未載入完成，請檢查網路連線後重試。");
    return;
  }

  // 建立 ExcelJS 活頁簿物件
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "業績整合分析系統 V2.5.1";
  workbook.created = new Date();

  // 共用框線樣式定義
  const thinGridBorder = {
    top: { style: "thin", color: { argb: "FFE5E7EB" } },
    left: { style: "thin", color: { argb: "FFE5E7EB" } },
    bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
    right: { style: "thin", color: { argb: "FFE5E7EB" } }
  };
  const headerBorder = {
    top: { style: "thin", color: { argb: "FF365F91" } },
    left: { style: "thin", color: { argb: "FF365F91" } },
    bottom: { style: "thin", color: { argb: "FF365F91" } },
    right: { style: "thin", color: { argb: "FF365F91" } }
  };
  const totalRowBorder = {
    top: { style: "thin", color: { argb: "FF9CA3AF" } },
    left: { style: "thin", color: { argb: "FFE5E7EB" } },
    bottom: { style: "double", color: { argb: "FF4B5563" } },
    right: { style: "thin", color: { argb: "FFE5E7EB" } }
  };

  for (const item of REPORT_SEQUENCE) {
    if (!selectedReportsMap.has(item.key)) continue;

    const matrix = selectedReportsMap.get(item.key);
    if (!matrix || matrix.length === 0) continue;

    const headers = matrix[0] || [];
    const sheetName = getExcelSheetName(item.key);

    // 建立工作表並凍結第 1 列標題
    const worksheet = workbook.addWorksheet(sheetName, {
      views: [{ state: "frozen", ySplit: 1 }]
    });

    // 追蹤各欄最大字元寬度以自動調整欄寬
    const maxColLengths = headers.map(h => String(h ?? "").length * 2.1);

    // 1. 寫入表頭列 (第 1 列)
    const headerRow = worksheet.addRow(headers);
    headerRow.height = 24;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF244061" }
      };
      cell.font = {
        name: "Microsoft JhengHei",
        size: 10,
        bold: true,
        color: { argb: "FFFFFFFF" }
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = headerBorder;
    });

    // 2. 逐列寫入資料列並套用對齊、數值格式與條件式底色
    for (let rIdx = 1; rIdx < matrix.length; rIdx++) {
      const rawRow = matrix[rIdx];
      const firstCell = String(rawRow[0] ?? "").trim();

      const isTotalRow = firstCell.includes("總計");
      const isContractRow = item.key === "S2_R2" && String(rawRow[7] ?? "") === "承件沒有銷售明細";
      const isLightBlueRow = item.key === "S1_R6" && S1_R6_MAIN_CATEGORIES.includes(firstCell);
      const growthStyle = item.key === "S3_GROWTH" ? GROWTH_ROW_STYLES[firstCell] : null;

      // 準備儲存格寫入值陣列
      const processedRow = rawRow.map((val, cIdx) => {
        const colName = String(headers[cIdx] ?? "");
        if (isPercentColumn(colName) && typeof val === "number") {
          return `${(val * 100).toFixed(2)}%`;
        }
        return val ?? "";
      });

      const excelRow = worksheet.addRow(processedRow);
      excelRow.height = 20;

      // 決定整列之預設底色與字體顏色
      let rowFillArgb = rIdx % 2 === 0 ? "FFF9FAFB" : null;
      let rowFontArgb = "FF1F2937";
      let rowBold = false;
      let rowBorder = thinGridBorder;

      if (isTotalRow) {
        rowFillArgb = "FFE5E7EB";
        rowBold = true;
        rowBorder = totalRowBorder;
      } else if (growthStyle) {
        rowFillArgb = growthStyle.bgArgb;
        rowFontArgb = growthStyle.fontArgb;
        rowBold = true;
      } else if (isContractRow) {
        rowFillArgb = "FFF2E6FF";
      } else if (isLightBlueRow) {
        rowFillArgb = "FFDBEAFE";
        rowFontArgb = "FF1E3A8A";
        rowBold = true;
      }

      excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const cIdx = colNumber - 1;
        const colName = String(headers[cIdx] ?? "");
        const cellVal = processedRow[cIdx];

        // 估算寬度以更新該欄最大寬度
        const valStr = typeof cellVal === "number" ? cellVal.toLocaleString("zh-TW") : String(cellVal ?? "");
        const estLen = valStr.length * (/[^\x00-\xff]/.test(valStr) ? 1.9 : 1.15);
        if (estLen > maxColLengths[cIdx]) {
          maxColLengths[cIdx] = estLen;
        }

        // 對齊規範：首欄置中且粗體，其餘儲存格靠右對齊
        cell.alignment = {
          horizontal: cIdx === 0 ? "center" : "right",
          vertical: "middle"
        };

        // 數值千分位格式化
        if (typeof cellVal === "number" && (isAmountOrQtyColumn(colName) || item.key === "S3_GROWTH")) {
          cell.numFmt = "#,##0";
        }

        // 子項縮排文字色調整（無特殊底色時套用次要灰）
        let finalFontArgb = rowFontArgb;
        let finalFillArgb = rowFillArgb;
        let finalBold = rowBold || cIdx === 0;

        if (!rowFillArgb && typeof cellVal === "string" && cellVal.includes("└")) {
          finalFontArgb = "FF4B5563";
        }

        // S2_R2 未取件列表「尚欠尾款」大於 0 紅底紅字警示
        if (!isTotalRow && item.key === "S2_R2" && cIdx === 5 && typeof cellVal === "number" && cellVal > 0) {
          finalFillArgb = "FFFFE6E6";
          finalFontArgb = "FFDC2626";
          finalBold = true;
        }

        if (finalFillArgb) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: finalFillArgb }
          };
        }

        cell.font = {
          name: "Microsoft JhengHei",
          size: 10,
          bold: finalBold,
          color: { argb: finalFontArgb }
        };
        cell.border = rowBorder;
      });
    }

    // 3. 套用自動計算之欄寬
    worksheet.columns = maxColLengths.map(len => ({
      width: Math.min(Math.max(Math.ceil(len + 4), 12), 48)
    }));
  }

  // 4. 產生動態檔名並觸發瀏覽器下載
  const now = new Date();
  const dateStr = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, "0")
    + String(now.getDate()).padStart(2, "0");

  let fileName = `營運綜合統計報表_${dateStr}.xlsx`;
  if (hasS1 && !hasS2) fileName = `門市業績統計報表_${dateStr}.xlsx`;
  else if (!hasS1 && hasS2) fileName = `訂金未取貨統計表_${dateStr}.xlsx`;

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });

  const downloadUrl = URL.createObjectURL(blob);
  const linkEl = document.createElement("a");
  linkEl.href = downloadUrl;
  linkEl.download = fileName;
  document.body.appendChild(linkEl);
  linkEl.click();
  document.body.removeChild(linkEl);
  URL.revokeObjectURL(downloadUrl);
}
