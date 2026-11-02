/**
 * 模組名稱：subReportsSales.js (Slot 1 門市銷售運算模組 V2.2)
 * 職責：以「門銷原始報表」為唯一來源，建構 S1_RAW、S1_R6(分類業績報表) 與 S1_STAFF(人員業績統計)
 * 備註：已徹底移除 S1_R1 銷貨明細表與 S1_R3 人員績效統計
 */

import {
  cleanStringVal,
  safeDouble,
  safeRound,
  calcUntaxedAmount,
  padZeroLeft,
  isExcludedStaffE,
  validateSchema
} from "./commonUtils.js";

import {
  CAT_FRAME_LENS,
  CAT_LONG_WEAR,
  CAT_OK_LENS,
  CAT_VC_DAILY,
  CAT_PHARMA_DAILY,
  CAT_SANMING,
  CAT_DISCOUNT_ADJ,
  CAT_BONUS_REDEEM,
  CAT_MARKETING_ACT,
  SUB_FRAME,
  SUB_SINGLE_LENS,
  SUB_MULTI_LENS,
  SUB_VC_LENS,
  evaluateUnifiedCategory
} from "./bizRules.js";

/**
 * 取得欄位索引（支援多個同義欄位名稱依序查找）
 * @param {Map<string, number>} colMap - 欄位名稱對應索引之映射物件
 * @param {string[]} aliases - 候選欄位名稱陣列
 * @returns {number} 欄位索引，若查無則回傳 -1
 */
function getColIndex(colMap, aliases) {
  for (const name of aliases) {
    if (colMap.has(name)) {
      return colMap.get(name);
    }
  }
  return -1;
}

/**
 * 將商品業務分類映射至大分類索引 (0~6)
 * @param {string} sCat - 業務分類名稱
 * @returns {number} 大分類索引值（-1 代表非標準大類）
 */
function getS1CategoryIndex(sCat) {
  switch (sCat) {
    case CAT_FRAME_LENS: return 0;
    case CAT_LONG_WEAR: return 1;
    case CAT_OK_LENS: return 2;
    case CAT_VC_DAILY: return 4;
    case CAT_PHARMA_DAILY: return 5;
    case CAT_SANMING: return 6;
    default: return -1;
  }
}

/**
 * 執行 Slot 1 門市銷售報表運算管線
 * @param {{headers: string[], rows: string[][], colMap: Map<string, number>}} parsedData - 解析完成之來源資料物件
 * @returns {Object} 包含 S1_RAW, S1_R6, S1_STAFF 的報表矩陣物件
 */
export function runSalesSubReport(parsedData) {
  const { rows, colMap } = parsedData;

  // 1. 檢驗必備欄位
  const reqCols = [
    ["銷貨日期", "建檔日期"],
    "三聯單號",
    "門銷單號",
    "條碼編號",
    ["品名", "商品品名"],
    "數量",
    "小計(含)",
    ["小計(未稅)"],
    "銷售人員"
  ];
  const check = validateSchema(colMap, reqCols);
  if (!check.isValid) {
    throw new Error(`門市銷售檔案缺少必要欄位：${check.missingMsg}`);
  }

  // 擷取各欄位索引
  const cTriNo = getColIndex(colMap, ["三聯單號"]);
  const cCode = getColIndex(colMap, ["條碼編號"]);
  const cName = getColIndex(colMap, ["品名", "商品品名"]);
  const cQty = getColIndex(colMap, ["數量"]);
  const cAmt = getColIndex(colMap, ["小計(含)"]);
  const cUntaxAmt = getColIndex(colMap, ["小計(未稅)"]);
  const cSalesCode = getColIndex(colMap, ["銷售人員"]);
  const cSalesName = getColIndex(colMap, ["銷售人員名稱"]);
  const cMainCatCode = getColIndex(colMap, ["主類編號"]);
  const cMainCatName = getColIndex(colMap, ["商品主類"]);

  // =========================================================================
  // 【建立 S1_RAW 門銷原始報表】作為所有工作表唯一資料來源中樞 (21 欄)
  // =========================================================================
  const rawHeaders = [
    "門銷單號", "條碼編號", "品名", "數量", "單價(含)", "小計(含)",
    "銷售人員", "銷售人員名稱", "驗光人員", "驗光人員名稱", "交件人員", "交件人員名稱",
    "分倉編號", "分倉名稱", "小計(未稅)", "銷貨日期", "三聯單號", "發票號碼",
    "電商訂編", "主類編號", "商品主類"
  ];
  const rawRows = [rawHeaders];
  for (const row of rows) {
    const rawRow = rawHeaders.map(h => {
      const idx = colMap.get(h);
      return idx !== undefined && idx >= 0 ? cleanStringVal(row[idx]) : "";
    });
    rawRows.push(rawRow);
  }

  // 大分類統計累加器 (門市人員)：0:框片, 1:長戴, 2:OK LENS, 4:視控日拋, 5:藥拋
  const storeCatQty = new Array(7).fill(0);
  const storeCatAmt = new Array(7).fill(0);
  const storeCatUntax = new Array(7).fill(0);

  // 框片四子類累加器 (門市人員)：鏡框, 單焦鏡片, 多焦鏡片, 視控鏡片
  const frameSubStats = {
    [SUB_FRAME]: { qty: 0, amt: 0, untax: 0 },
    [SUB_SINGLE_LENS]: { qty: 0, amt: 0, untax: 0 },
    [SUB_MULTI_LENS]: { qty: 0, amt: 0, untax: 0 },
    [SUB_VC_LENS]: { qty: 0, amt: 0, untax: 0 }
  };

  // 金三明統計累加器 (門市 vs 診所)
  const sanmingStats = {
    store: { qty: 0, amt: 0, untax: 0 },   // 門市人員 (非 E/e)
    clinic: { qty: 0, amt: 0, untax: 0 }   // 診所人員 (E/e)
  };

  // 折抵項累加器 (門市人員)
  let discountAmt = 0;
  let discountUntax = 0;
  let discountQty = 0;

  // 人員業績統計字典 (僅統計門市人員，以工號為鍵值)
  const staffStatsMap = new Map();

  // =========================================================================
  // 逐筆遍歷清洗資料，依人員身分與業務分類分流
  // =========================================================================
  for (const row of rows) {
    const sTri = padZeroLeft(row[cTriNo], 12);
    if (sTri === "") continue;

    const sCode = cleanStringVal(row[cCode]);
    const sName = cleanStringVal(row[cName]);
    const dQty = safeDouble(row[cQty]);
    const dSubTax = safeDouble(row[cAmt]);
    const dSubUntax = cUntaxAmt >= 0 ? safeDouble(row[cUntaxAmt]) : calcUntaxedAmount(dSubTax);

    const sStaffCode = cleanStringVal(row[cSalesCode]);
    const sStaffName = cSalesName >= 0 ? cleanStringVal(row[cSalesName]) : "";
    const sMainCatCode = cMainCatCode >= 0 ? cleanStringVal(row[cMainCatCode]) : "";
    const sMainCatName = cMainCatName >= 0 ? cleanStringVal(row[cMainCatName]) : "";

    // 業務分類判定（已於函式內部優先排除視控鏡片，確保多焦鏡片不包含視控鏡片）
    const evalRes = evaluateUnifiedCategory(sCode, sName, dSubTax, "", sMainCatName, sMainCatCode);
    const sBizCat = evalRes.category;
    const sSubCat = evalRes.subCategory;

    // 判定銷售同仁是否為診所人員 (E/e 開頭)
    const isClinicStaff = isExcludedStaffE(sStaffCode);

    // =======================================================================
    // 業務邊界核心判定：診所人員僅認列金三明；其餘非金三明品項全數排除
    // =======================================================================
    if (sBizCat === CAT_SANMING) {
      if (isClinicStaff) {
        sanmingStats.clinic.qty += dQty;
        sanmingStats.clinic.amt += dSubTax;
        sanmingStats.clinic.untax += dSubUntax;
      } else {
        sanmingStats.store.qty += dQty;
        sanmingStats.store.amt += dSubTax;
        sanmingStats.store.untax += dSubUntax;
      }
    } else if (isClinicStaff) {
      // 診所人員之非金三明品項全數跳過
      continue;
    } else {
      // 門市人員常規品項加總
      const idxCat = getS1CategoryIndex(sBizCat);
      if (idxCat >= 0 && idxCat <= 5) {
        storeCatQty[idxCat] += dQty;
        storeCatAmt[idxCat] += dSubTax;
        storeCatUntax[idxCat] += dSubUntax;

        if (sBizCat === CAT_FRAME_LENS && frameSubStats[sSubCat]) {
          frameSubStats[sSubCat].qty += dQty;
          frameSubStats[sSubCat].amt += dSubTax;
          frameSubStats[sSubCat].untax += dSubUntax;
        }
      } else if (sBizCat === CAT_MARKETING_ACT || sBizCat === CAT_BONUS_REDEEM) {
        discountQty += dQty;
        discountAmt += dSubTax;
        discountUntax += dSubUntax;
      }
    }

    // =======================================================================
    // 門市人員業績統計累加（依工號聚合，金額全數採未稅金額）
    // =======================================================================
    if (!isClinicStaff && sStaffCode !== "") {
      if (!staffStatsMap.has(sStaffCode)) {
        staffStatsMap.set(sStaffCode, {
          staffCode: sStaffCode,
          staffName: sStaffName || sStaffCode,
          frameUntax: 0,
          multiUntax: 0,
          vcUntax: 0,
          okUntax: 0,
          vcDailyUntax: 0,
          sanmingUntax: 0,
          totalUntax: 0
        });
      }
      const st = staffStatsMap.get(sStaffCode);
      st.totalUntax += dSubUntax;

      if (sBizCat === CAT_FRAME_LENS) {
        st.frameUntax += dSubUntax;
        if (sSubCat === SUB_MULTI_LENS) {
          st.multiUntax += dSubUntax;
        } else if (sSubCat === SUB_VC_LENS) {
          st.vcUntax += dSubUntax;
        }
      } else if (sBizCat === CAT_OK_LENS) {
        st.okUntax += dSubUntax;
      } else if (sBizCat === CAT_VC_DAILY) {
        st.vcDailyUntax += dSubUntax;
      } else if (sBizCat === CAT_SANMING) {
        st.sanmingUntax += dSubUntax;
      }
    }
  }

  // 組裝報表
  const r6Rows = buildS1R6(
    storeCatQty, storeCatAmt, storeCatUntax,
    frameSubStats, sanmingStats,
    discountQty, discountAmt, discountUntax
  );
  const staffRows = buildStaffPerformanceReport(staffStatsMap);

  return {
    S1_RAW: rawRows,
    S1_R6: r6Rows,
    S1_STAFF: staffRows
  };
}

/**
 * 組裝 S1_R6 分類業績報表 (4 欄結構，大類淺藍底色)
 * 欄位：A:分類, B:銷售數量, C:含稅售價, D:未稅售價
 * @param {number[]} storeCatQty - 大類數量陣列
 * @param {number[]} storeCatAmt - 大類含稅售價陣列
 * @param {number[]} storeCatUntax - 大類未稅售價陣列
 * @param {Object} frameSubStats - 框片四子類統計物件
 * @param {Object} sanmingStats - 金三明統計物件
 * @param {number} discountQty - 折抵數量
 * @param {number} discountAmt - 折抵含稅金額
 * @param {number} discountUntax - 折抵未稅金額
 * @returns {any[][]} S1_R6 二維陣列
 */
function buildS1R6(
  storeCatQty, storeCatAmt, storeCatUntax,
  frameSubStats, sanmingStats,
  discountQty, discountAmt, discountUntax
) {
  const r6Rows = [["分類", "銷售數量", "含稅售價", "未稅售價"]];

  // 金三明全員加總
  const sanmingTotalQty = sanmingStats.store.qty + sanmingStats.clinic.qty;
  const sanmingTotalTax = sanmingStats.store.amt + sanmingStats.clinic.amt;
  const sanmingTotalUntax = sanmingStats.store.untax + sanmingStats.clinic.untax;

  // 定義行項結構
  const items = [
    // 1. 框片
    { name: CAT_FRAME_LENS, qty: storeCatQty[0], tax: storeCatAmt[0], untax: storeCatUntax[0], isMain: true },
    { name: `  └ ${SUB_FRAME} (金額已含於框片)`, qty: frameSubStats[SUB_FRAME].qty, tax: frameSubStats[SUB_FRAME].amt, untax: frameSubStats[SUB_FRAME].untax, isMain: false },
    { name: `  └ ${SUB_SINGLE_LENS} (金額已含於框片)`, qty: frameSubStats[SUB_SINGLE_LENS].qty, tax: frameSubStats[SUB_SINGLE_LENS].amt, untax: frameSubStats[SUB_SINGLE_LENS].untax, isMain: false },
    { name: `  └ ${SUB_MULTI_LENS} (金額已含於框片)`, qty: frameSubStats[SUB_MULTI_LENS].qty, tax: frameSubStats[SUB_MULTI_LENS].amt, untax: frameSubStats[SUB_MULTI_LENS].untax, isMain: false },
    { name: `  └ ${SUB_VC_LENS} (金額已含於框片)`, qty: frameSubStats[SUB_VC_LENS].qty, tax: frameSubStats[SUB_VC_LENS].amt, untax: frameSubStats[SUB_VC_LENS].untax, isMain: false },

    // 2. 長戴
    { name: CAT_LONG_WEAR, qty: storeCatQty[1], tax: storeCatAmt[1], untax: storeCatUntax[1], isMain: true },

    // 3. OK LENS
    { name: CAT_OK_LENS, qty: storeCatQty[2], tax: storeCatAmt[2], untax: storeCatUntax[2], isMain: true },

    // 4. 視控日拋
    { name: CAT_VC_DAILY, qty: storeCatQty[4], tax: storeCatAmt[4], untax: storeCatUntax[4], isMain: true },

    // 5. 藥拋
    { name: CAT_PHARMA_DAILY, qty: storeCatQty[5], tax: storeCatAmt[5], untax: storeCatUntax[5], isMain: true },

    // 6. 金三明 (全員)
    { name: CAT_SANMING, qty: sanmingTotalQty, tax: sanmingTotalTax, untax: sanmingTotalUntax, isMain: true },
    { name: "  └ 門市", qty: sanmingStats.store.qty, tax: sanmingStats.store.amt, untax: sanmingStats.store.untax, isMain: false },
    { name: "  └ 診所", qty: sanmingStats.clinic.qty, tax: sanmingStats.clinic.amt, untax: sanmingStats.clinic.untax, isMain: false },

    // 7. 帳務調整與折抵
    { name: CAT_DISCOUNT_ADJ, qty: discountQty, tax: discountAmt, untax: discountUntax, isMain: false }
  ];

  let grossQty = 0, grossTax = 0, grossUntax = 0;
  for (const it of items) {
    if (it.isMain) {
      grossQty += it.qty;
      grossTax += it.tax;
      grossUntax += it.untax;
    }
    r6Rows.push([
      it.name,
      safeRound(it.qty, 0),
      safeRound(it.tax, 0),
      safeRound(it.untax, 0)
    ]);
  }

  // 門市實收淨額總計 = 六大類加總 + 折抵(負額)
  const netQty = grossQty + discountQty;
  const netTax = grossTax + discountAmt;
  const netUntax = grossUntax + discountUntax;

  r6Rows.push([
    "門市實收淨額總計",
    safeRound(netQty, 0),
    safeRound(netTax, 0),
    safeRound(netUntax, 0)
  ]);

  return r6Rows;
}

/**
 * 組裝「人員業績統計」工作表（依銷售人員工號昇冪排序，純姓名呈現，未稅金額統計）
 * @param {Map<string, Object>} staffStatsMap - 門市人員業績統計物件之映射表
 * @returns {any[][]} 人員業績統計二維陣列
 */
function buildStaffPerformanceReport(staffStatsMap) {
  const staffHeaders = [
    "銷售人員", "框片總額", "多焦鏡片", "視控鏡片",
    "OK LENS", "視控日拋", "金三明", "總業績"
  ];
  const reportRows = [staffHeaders];

  // 將人員物件轉為陣列並依工號昇冪排序
  const sortedStaffList = Array.from(staffStatsMap.values()).sort((itemA, itemB) => {
    return itemA.staffCode.localeCompare(itemB.staffCode, undefined, { numeric: true });
  });

  let sumFrame = 0;
  let sumMulti = 0;
  let sumVC = 0;
  let sumOK = 0;
  let sumVCDaily = 0;
  let sumSanming = 0;
  let sumTotal = 0;

  for (const st of sortedStaffList) {
    const dFrame = safeRound(st.frameUntax, 0);
    const dMulti = safeRound(st.multiUntax, 0);
    const dVC = safeRound(st.vcUntax, 0);
    const dOK = safeRound(st.okUntax, 0);
    const dVCDaily = safeRound(st.vcDailyUntax, 0);
    const dSanming = safeRound(st.sanmingUntax, 0);
    const dTotal = safeRound(st.totalUntax, 0);

    reportRows.push([
      st.staffName,
      dFrame,
      dMulti,
      dVC,
      dOK,
      dVCDaily,
      dSanming,
      dTotal
    ]);

    sumFrame += dFrame;
    sumMulti += dMulti;
    sumVC += dVC;
    sumOK += dOK;
    sumVCDaily += dVCDaily;
    sumSanming += dSanming;
    sumTotal += dTotal;
  }

  // 加入總計列
  reportRows.push([
    "總計",
    safeRound(sumFrame, 0),
    safeRound(sumMulti, 0),
    safeRound(sumVC, 0),
    safeRound(sumOK, 0),
    safeRound(sumVCDaily, 0),
    safeRound(sumSanming, 0),
    safeRound(sumTotal, 0)
  ]);

  return reportRows;
}