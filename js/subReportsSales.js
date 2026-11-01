/**
 * 模組名稱：subReportsSales.js (Slot 1 門市銷售運算模組 V1.0)
 * 職責：以「門銷原始報表」為唯一來源，建構 S1_RAW、S1_R1(銷貨明細表)、S1_R3、S1_R4、S1_R5 與 S1_R6(分類業績報表)
 */

import {
  cleanStringVal,
  safeDouble,
  safeRound,
  calcUntaxedAmount,
  formatDateStd,
  padZeroLeft,
  isExcludedStaffE,
  validateSchema
} from "./commonUtils.js";

import {
  CAT_FRAME_LENS,
  CAT_LONG_WEAR,
  CAT_OK_LENS,
  CAT_VC_LENS,
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
  evaluateUnifiedCategory,
  getTransactionType
} from "./bizRules.js";

/**
 * 取得欄位索引（支援多個同義欄位名稱依序查找）
 * @param {Map<string, number>} colMap - 欄位名稱映射表
 * @param {string[]} aliases - 候選欄位名稱陣列
 * @returns {number} 欄位索引，找不到回傳 -1
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
 * @returns {number} 索引值（-1 代表非標準大類）
 */
function getS1CategoryIndex(sCat) {
  switch (sCat) {
    case CAT_FRAME_LENS: return 0;
    case CAT_LONG_WEAR: return 1;
    case CAT_OK_LENS: return 2;
    case CAT_VC_LENS: return 3;
    case CAT_VC_DAILY: return 4;
    case CAT_PHARMA_DAILY: return 5;
    case CAT_SANMING: return 6;
    default: return -1;
  }
}

/**
 * 執行 Slot 1 門市銷售報表運算管線
 * @param {{headers: string[], rows: string[][], colMap: Map<string, number>}} parsedData - 解析後之來源資料
 * @returns {Object} 包含 S1_RAW, S1_R1, S1_R3, S1_R4, S1_R5, S1_R6 的報表封裝物件
 */
export function runSalesSubReport(parsedData) {
  const { headers, rows, colMap } = parsedData;

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
  const cDate = getColIndex(colMap, ["銷貨日期", "建檔日期"]);
  const cTriNo = getColIndex(colMap, ["三聯單號"]);
  const cDocNo = getColIndex(colMap, ["門銷單號"]);
  const cCode = getColIndex(colMap, ["條碼編號"]);
  const cName = getColIndex(colMap, ["品名", "商品品名"]);
  const cQty = getColIndex(colMap, ["數量"]);
  const cAmt = getColIndex(colMap, ["小計(含)"]);
  const cUntaxAmt = getColIndex(colMap, ["小計(未稅)"]);
  const cSalesCode = getColIndex(colMap, ["銷售人員"]);
  const cSalesName = getColIndex(colMap, ["銷售人員名稱"]);
  const cOptoCode = getColIndex(colMap, ["驗光人員"]);
  const cOptoName = getColIndex(colMap, ["驗光人員名稱"]);
  const cDeliverCode = getColIndex(colMap, ["交件人員"]);
  const cDeliverName = getColIndex(colMap, ["交件人員名稱"]);
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

  // =========================================================================
  // 【建立 S1_R1 銷貨明細表】(14 欄，刪除是否排除欄位)
  // =========================================================================
  const r1Headers = [
    "銷貨日期", "三聯單號", "門銷單號", "條碼編號", "商品品名",
    "數量", "小計(含)", "銷售人員", "驗光人員", "交件人員",
    "商品主類", "業務分類", "細項分類", "交易屬性"
  ];
  const r1Rows = [r1Headers];

  // 容器初始化
  const r3Map = new Map(); // 人員績效 (僅計門市人員)
  const r5Rows = [[
    "銷貨日期", "三聯單號", "業務分類", "細項分類",
    "商品品名", "數量", "小計(含)", "小計(未稅)", "銷售人員", "交易屬性"
  ]];

  // 大分類統計累加器 (門市人員)：0:框片, 1:長戴, 2:OK LENS, 3:視控鏡片(備用), 4:視控日拋, 5:藥拋
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

  // =========================================================================
  // 逐筆遍歷清洗資料，依人員身分與業務分類分流
  // =========================================================================
  for (const row of rows) {
    const sTri = padZeroLeft(row[cTriNo], 12);
    if (sTri === "") continue;

    const sDate = formatDateStd(row[cDate]);
    const sDoc = cleanStringVal(row[cDocNo]);
    const sCode = cleanStringVal(row[cCode]);
    const sName = cleanStringVal(row[cName]);
    const dQty = safeDouble(row[cQty]);
    const dSubTax = safeDouble(row[cAmt]);
    // 未稅售價直接取小計(未稅)，保留負數代數和自然沖銷
    const dSubUntax = cUntaxAmt >= 0 ? safeDouble(row[cUntaxAmt]) : calcUntaxedAmount(dSubTax);

    const sStaffCode = cleanStringVal(row[cSalesCode]);
    const sStaffName = cSalesName >= 0 ? cleanStringVal(row[cSalesName]) : "";
    const sSalesDisplay = sStaffName !== "" ? `${sStaffCode} ${sStaffName}` : sStaffCode;

    const sOptoCode = cOptoCode >= 0 ? cleanStringVal(row[cOptoCode]) : "";
    const sOptoName = cOptoName >= 0 ? cleanStringVal(row[cOptoName]) : "";
    const sOptoDisplay = sOptoName !== "" ? `${sOptoCode} ${sOptoName}` : sOptoCode;

    const sDeliverCode = cDeliverCode >= 0 ? cleanStringVal(row[cDeliverCode]) : "";
    const sDeliverName = cDeliverName >= 0 ? cleanStringVal(row[cDeliverName]) : "";
    const sDeliverDisplay = sDeliverName !== "" ? `${sDeliverCode} ${sDeliverName}` : sDeliverCode;

    const sMainCatCode = cMainCatCode >= 0 ? cleanStringVal(row[cMainCatCode]) : "";
    const sMainCatName = cMainCatName >= 0 ? cleanStringVal(row[cMainCatName]) : "";

    // 調用全局統一代碼路由引擎
    const evalRes = evaluateUnifiedCategory(sCode, sName, dSubTax, "", sMainCatName, sMainCatCode);
    const sBizCat = evalRes.category;
    const sSubCat = evalRes.subCategory;
    const sTransType = getTransactionType(sBizCat, dQty, dSubTax);

    // 1. 寫入 S1_R1 銷貨明細表 (全資料真實呈現，無是否排除欄位)
    r1Rows.push([
      sDate, sTri, sDoc, sCode, sName,
      dQty, dSubTax, sSalesDisplay, sOptoDisplay, sDeliverDisplay,
      sMainCatName, sBizCat, sSubCat, sTransType
    ]);

    // 判定銷售同仁是否為診所人員 (E/e 開頭)
    const isClinicStaff = isExcludedStaffE(sStaffCode);

    // =======================================================================
    // 業務邊界核心判定：
    // 診所人員僅計算金三明；非金三明品項全數不計入門市業績
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
      // 診所人員之非金三明品項，略過不計入後續報表
      continue;
    } else {
      // 門市人員常規品項
      const idxCat = getS1CategoryIndex(sBizCat);
      if (idxCat >= 0 && idxCat <= 5) {
        storeCatQty[idxCat] += dQty;
        storeCatAmt[idxCat] += dSubTax;
        storeCatUntax[idxCat] += dSubUntax;

        // 若屬於框片細分子項，累加至 frameSubStats
        if (sBizCat === CAT_FRAME_LENS && frameSubStats[sSubCat]) {
          frameSubStats[sSubCat].qty += dQty;
          frameSubStats[sSubCat].amt += dSubTax;
          frameSubStats[sSubCat].untax += dSubUntax;
        }

        // S1_R5 分類銷售明細 (門市人員)
        r5Rows.push([
          sDate, sTri, sBizCat, sSubCat,
          sName, dQty, dSubTax, dSubUntax, sSalesDisplay, sTransType
        ]);

        // S1_R3 人員績效統計 (僅計門市人員)
        if (sSalesDisplay !== "") {
          if (!r3Map.has(sSalesDisplay)) {
            r3Map.set(sSalesDisplay, {
              frameTotal: 0,
              singleLens: 0,
              multiLens: 0,
              vcLens: 0,
              longWear: 0,
              okLens: 0,
              vcDaily: 0,
              pharmaDaily: 0,
              sanmingStore: 0,
              totalQty: 0,
              untaxTotal: 0
            });
          }
          const pStat = r3Map.get(sSalesDisplay);
          if (idxCat === 0) pStat.frameTotal += dSubTax;
          if (sSubCat === SUB_SINGLE_LENS) pStat.singleLens += dSubTax;
          if (sSubCat === SUB_MULTI_LENS) pStat.multiLens += dSubTax;
          if (sSubCat === SUB_VC_LENS) pStat.vcLens += dSubTax;
          if (idxCat === 1) pStat.longWear += dSubTax;
          if (idxCat === 2) pStat.okLens += dSubTax;
          if (idxCat === 4) pStat.vcDaily += dSubTax;
          if (idxCat === 5) pStat.pharmaDaily += dSubTax;
          pStat.totalQty += dQty;
          pStat.untaxTotal += dSubUntax;
        }
      } else if (sBizCat === CAT_MARKETING_ACT || sBizCat === CAT_BONUS_REDEEM) {
        // 折抵項加總負數
        discountQty += dQty;
        discountAmt += dSubTax;
        discountUntax += dSubUntax;
      }
    }

    // 若門市人員有金三明，亦記入 S1_R3 人員績效
    if (!isClinicStaff && sBizCat === CAT_SANMING && sSalesDisplay !== "") {
      if (!r3Map.has(sSalesDisplay)) {
        r3Map.set(sSalesDisplay, {
          frameTotal: 0, singleLens: 0, multiLens: 0, vcLens: 0,
          longWear: 0, okLens: 0, vcDaily: 0, pharmaDaily: 0,
          sanmingStore: 0, totalQty: 0, untaxTotal: 0
        });
      }
      const pStat = r3Map.get(sSalesDisplay);
      pStat.sanmingStore += dSubTax;
      pStat.totalQty += dQty;
      pStat.untaxTotal += dSubUntax;
    }
  }

  // 組裝報表
  const r3Rows = buildS1R3(r3Map);
  const r4Rows = buildS1R4(storeCatAmt, frameSubStats, sanmingStats, discountAmt);
  const r6Rows = buildS1R6(storeCatQty, storeCatAmt, storeCatUntax, frameSubStats, sanmingStats, discountQty, discountAmt, discountUntax);

  return {
    S1_RAW: rawRows,
    S1_R1: r1Rows,
    S1_R3: r3Rows,
    S1_R4: r4Rows,
    S1_R5: r5Rows,
    S1_R6: r6Rows
  };
}

/**
 * 組裝 S1_R3 人員績效統計表（僅計門市人員）
 * @param {Map<string, Object>} r3Map - 門市人員績效 Map
 * @returns {any[][]} S1_R3 二維矩陣
 */
function buildS1R3(r3Map) {
  const r3Rows = [[
    "銷售人員", "框片總業績", "單焦鏡片", "多焦鏡片", "視控鏡片",
    "OK LENS業績", "長戴業績", "視控日拋業績", "一般藥拋業績",
    "金三明(門市)", "銷售總件數", "未稅總業績"
  ]];

  let sumFrame = 0, sumSingle = 0, sumMulti = 0, sumVC = 0;
  let sumOK = 0, sumLong = 0, sumVCDaily = 0, sumPharma = 0, sumSanming = 0;
  let sumQty = 0, sumUntaxed = 0;

  for (const [salesName, st] of r3Map.entries()) {
    r3Rows.push([
      salesName,
      safeRound(st.frameTotal, 0),
      safeRound(st.singleLens, 0),
      safeRound(st.multiLens, 0),
      safeRound(st.vcLens, 0),
      safeRound(st.okLens, 0),
      safeRound(st.longWear, 0),
      safeRound(st.vcDaily, 0),
      safeRound(st.pharmaDaily, 0),
      safeRound(st.sanmingStore, 0),
      safeRound(st.totalQty, 0),
      safeRound(st.untaxTotal, 0)
    ]);

    sumFrame += st.frameTotal;
    sumSingle += st.singleLens;
    sumMulti += st.multiLens;
    sumVC += st.vcLens;
    sumOK += st.okLens;
    sumLong += st.longWear;
    sumVCDaily += st.vcDaily;
    sumPharma += st.pharmaDaily;
    sumSanming += st.sanmingStore;
    sumQty += st.totalQty;
    sumUntaxed += st.untaxTotal;
  }

  r3Rows.push([
    "總計",
    safeRound(sumFrame, 0),
    safeRound(sumSingle, 0),
    safeRound(sumMulti, 0),
    safeRound(sumVC, 0),
    safeRound(sumOK, 0),
    safeRound(sumLong, 0),
    safeRound(sumVCDaily, 0),
    safeRound(sumPharma, 0),
    safeRound(sumSanming, 0),
    safeRound(sumQty, 0),
    safeRound(sumUntaxed, 0)
  ]);

  return r3Rows;
}

/**
 * 組裝 S1_R4 品類營收分析表
 * @param {number[]} storeCatAmt - 門市大類含稅金額
 * @param {Object} frameSubStats - 框片子類統計
 * @param {Object} sanmingStats - 金三明統計
 * @param {number} discountAmt - 折抵含稅總額
 * @returns {any[][]} S1_R4 二維矩陣
 */
function buildS1R4(storeCatAmt, frameSubStats, sanmingStats, discountAmt) {
  const sanmingTotalTax = sanmingStats.store.amt + sanmingStats.clinic.amt;
  const dGross = storeCatAmt[0] + storeCatAmt[1] + storeCatAmt[2] + storeCatAmt[4] + storeCatAmt[5] + sanmingTotalTax;
  const dNet = dGross + discountAmt;

  const displayItems = [
    { name: CAT_FRAME_LENS, amt: storeCatAmt[0], note: "含鏡框與鏡片全系列 (僅門市)" },
    { name: `  └ ${SUB_FRAME} (金額已含於框片)`, amt: frameSubStats[SUB_FRAME].amt, note: "鏡框市售與名牌" },
    { name: `  └ ${SUB_SINGLE_LENS} (金額已含於框片)`, amt: frameSubStats[SUB_SINGLE_LENS].amt, note: "單焦鏡片 (已排除視控)" },
    { name: `  └ ${SUB_MULTI_LENS} (金額已含於框片)`, amt: frameSubStats[SUB_MULTI_LENS].amt, note: "多焦鏡片 (已排除視控)" },
    { name: `  └ ${SUB_VC_LENS} (金額已含於框片)`, amt: frameSubStats[SUB_VC_LENS].amt, note: "近視控制鏡片 (11組詞庫)" },
    { name: CAT_LONG_WEAR, amt: storeCatAmt[1], note: "常規硬式/軟式長戴型" },
    { name: CAT_OK_LENS, amt: storeCatAmt[2], note: "角膜塑型片" },
    { name: CAT_VC_DAILY, amt: storeCatAmt[4], note: "視控日拋隱形眼鏡" },
    { name: CAT_PHARMA_DAILY, amt: storeCatAmt[5], note: "一般拋棄式與藥水耗材" },
    { name: CAT_SANMING, amt: sanmingTotalTax, note: "金三明保健食品 (門市+診所全員)" },
    { name: "  └ 門市 (非E/e人員)", amt: sanmingStats.store.amt, note: "門市專任人員銷售" },
    { name: "  └ 診所 (E/e人員)", amt: sanmingStats.clinic.amt, note: "診所醫療同仁銷售" }
  ];

  const r4Rows = [["營收結構板塊", "實收金額(含稅)", "營業額佔比(%)", "業務備註"]];
  for (const item of displayItems) {
    const amtRounded = safeRound(item.amt, 0);
    const ratio = dGross > 0 ? item.amt / dGross : 0;
    r4Rows.push([item.name, amtRounded, ratio, item.note]);
  }

  r4Rows.push([CAT_DISCOUNT_ADJ, safeRound(discountAmt, 0), 0, "含紅利與行銷折抵負額"]);
  r4Rows.push(["門市實收淨額總計", safeRound(dNet, 0), dGross > 0 ? 1 : 0, "大類加總並扣除折抵 (不重複計入子項)"]);

  return r4Rows;
}

/**
 * 組裝 S1_R6 分類業績報表 (整合 S1_R6 + S1_R7 核心新表，4 欄結構，淺藍底色)
 * 欄位：A:分類, B:銷售數量, C:含稅售價, D:未稅售價
 * @param {number[]} storeCatQty - 大類數量
 * @param {number[]} storeCatAmt - 大類含稅售價
 * @param {number[]} storeCatUntax - 大類未稅售價
 * @param {Object} frameSubStats - 框片四子類
 * @param {Object} sanmingStats - 金三明統計
 * @param {number} discountQty - 折抵數量
 * @param {number} discountAmt - 折抵含稅售價
 * @param {number} discountUntax - 折抵未稅售價
 * @returns {any[][]} S1_R6 二維矩陣
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

  // 定義行項順序
  const items = [
    // 1. 框片 (大類加總項)
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
    { name: "  └ 門市 (非E/e人員)", qty: sanmingStats.store.qty, tax: sanmingStats.store.amt, untax: sanmingStats.store.untax, isMain: false },
    { name: "  └ 診所 (E/e人員)", qty: sanmingStats.clinic.qty, tax: sanmingStats.clinic.amt, untax: sanmingStats.clinic.untax, isMain: false },

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
