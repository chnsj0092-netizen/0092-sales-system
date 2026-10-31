/**
 * 模組名稱：subReportsSales.js (Slot 1 門市銷售運算模組)
 * 職責：解析門市銷售明細表，支援「鏡片細分三類（單焦/多焦/視控）」與「主動排除 E/e 開頭人員」，建構 S1_R1 ~ S1_R7
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
  LENS_SUB_SINGLE,
  LENS_SUB_MULTI,
  LENS_SUB_VC,
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
 * 將商品業務分類映射至 Slot 1 大分類索引 (0~6)
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
 * @param {boolean} excludeStaffE - 是否主動排除 E/e 開頭之銷售人員（預設為 true）
 * @returns {Object} 包含 S1_R1 ~ S1_R7 的報表封裝物件
 */
export function runSalesSubReport(parsedData, excludeStaffE = true) {
  const { rows, colMap } = parsedData;

  // 1. 檢驗必備欄位（相容「銷貨日期/建檔日期」與「品名/商品品名」）
  const reqCols = [
    ["銷貨日期", "建檔日期"],
    "三聯單號",
    "門銷單號",
    "條碼編號",
    ["品名", "商品品名"],
    "數量",
    "小計(含)",
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
  const cSalesCode = getColIndex(colMap, ["銷售人員"]);
  const cSalesName = getColIndex(colMap, ["銷售人員名稱"]);
  const cOptoCode = getColIndex(colMap, ["驗光人員"]);
  const cOptoName = getColIndex(colMap, ["驗光人員名稱"]);
  const cDeliverCode = getColIndex(colMap, ["交件人員"]);
  const cDeliverName = getColIndex(colMap, ["交件人員名稱"]);
  const cMainCatCode = getColIndex(colMap, ["主類編號"]);
  const cMainCatName = getColIndex(colMap, ["商品主類"]);

  // [Pass 1] 計算每張三聯單之實收總額（用於排除 0 元沖銷單；若設定排除 E/e 人員則僅計非 E 人員品項）
  const orderNetMap = new Map();
  for (const row of rows) {
    const sTri = padZeroLeft(row[cTriNo], 12);
    if (sTri === "") continue;

    const sStaffCode = cleanStringVal(row[cSalesCode]);
    if (excludeStaffE && isExcludedStaffE(sStaffCode)) {
      continue;
    }

    const dSub = safeDouble(row[cAmt]);
    orderNetMap.set(sTri, (orderNetMap.get(sTri) || 0) + dSub);
  }

  // [Pass 2] 準備各報表容器
  const r1Headers = [
    "銷貨日期", "三聯單號", "門銷單號", "條碼編號", "商品品名",
    "數量", "小計(含)", "銷售人員", "驗光人員", "交件人員",
    "商品主類", "業務分類", "鏡片細分", "交易屬性", "是否排除"
  ];
  const r1Rows = [r1Headers];

  // S1_R2 單據彙整 Map
  const r2Map = new Map();

  // S1_R3 人員績效 Map: key = 銷售人員顯示名稱
  const r3Map = new Map();

  // 大分類累加器：0:框片, 1:長戴, 2:OK LENS, 3:視控鏡片(備用), 4:視控日拋, 5:藥拋, 6:金三明, 7:行銷折抵, 8:紅利折抵
  const catQty = new Array(9).fill(0);
  const catAmt = new Array(9).fill(0);

  // 鏡片細分三分類累加器：單焦鏡片、多焦鏡片、視控鏡片
  const lensSubStats = {
    [LENS_SUB_SINGLE]: { qty: 0, amt: 0 },
    [LENS_SUB_MULTI]: { qty: 0, amt: 0 },
    [LENS_SUB_VC]: { qty: 0, amt: 0 }
  };

  // S1_R5 分類銷售明細容器
  const r5Rows = [[
    "銷貨日期", "三聯單號", "業務分類", "鏡片細分",
    "商品品名", "數量", "小計(含)", "銷售人員", "交易屬性"
  ]];

  // [Pass 3] 逐筆清洗、代碼路由與聚合
  for (const row of rows) {
    const sTri = padZeroLeft(row[cTriNo], 12);
    if (sTri === "") continue;

    const sDate = formatDateStd(row[cDate]);
    const sDoc = cleanStringVal(row[cDocNo]);
    const sCode = cleanStringVal(row[cCode]);
    const sName = cleanStringVal(row[cName]);
    const dQty = safeDouble(row[cQty]);
    const dSub = safeDouble(row[cAmt]);

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

    // 呼叫統一代碼路由與鏡片三分類引擎
    const evalRes = evaluateUnifiedCategory(sCode, sName, dSub, "", sMainCatName, sMainCatCode);
    const sBizCat = evalRes.category;
    const sLensSub = evalRes.lensSubCategory;
    const sTransType = getTransactionType(sBizCat, dQty, dSub);

    // 判定是否因 E/e 開頭人員或 0 元單而被排除
    const bStaffExcluded = excludeStaffE && isExcludedStaffE(sStaffCode);
    const dOrdNet = safeRound(orderNetMap.get(sTri) || 0, 0);
    const bZeroOrderExcluded = !bStaffExcluded && dOrdNet === 0;

    let excludeStatus = "計入";
    if (bStaffExcluded) {
      excludeStatus = "排除(E/e人員)";
    } else if (bZeroOrderExcluded) {
      excludeStatus = "排除(0元單)";
    }

    // 寫入 S1_R1 原始銷售明細
    r1Rows.push([
      sDate, sTri, sDoc, sCode, sName,
      dQty, dSub, sSalesDisplay, sOptoDisplay, sDeliverDisplay,
      sMainCatName, sBizCat, sLensSub, sTransType, excludeStatus
    ]);

    // 若被排除則不納入後續 S1_R2 ~ S1_R7 金額與件數計算
    if (bStaffExcluded || bZeroOrderExcluded) {
      continue;
    }

    // 聚合 S1_R2 單據彙整
    if (!r2Map.has(sTri)) {
      r2Map.set(sTri, {
        date: sDate,
        docNo: sDoc,
        sales: sSalesDisplay,
        posAmt: 0,
        negAmt: 0,
        netAmt: 0
      });
    }
    const r2Item = r2Map.get(sTri);
    if (dSub > 0) {
      r2Item.posAmt += dSub;
    } else {
      r2Item.negAmt += dSub;
    }
    r2Item.netAmt = r2Item.posAmt + r2Item.negAmt;

    // 聚合大分類與鏡片細分統計
    const idxCat = getS1CategoryIndex(sBizCat);
    if (idxCat >= 0 && idxCat <= 6) {
      catQty[idxCat] += dQty;
      catAmt[idxCat] += dSub;

      // 若屬於鏡片三分類（單焦、多焦、視控），同步累加至鏡片細分統計器
      if (lensSubStats[sLensSub]) {
        lensSubStats[sLensSub].qty += dQty;
        lensSubStats[sLensSub].amt += dSub;
      }

      // 記錄 S1_R5 分類銷售明細
      r5Rows.push([
        sDate, sTri, sBizCat, sLensSub,
        sName, dQty, dSub, sSalesDisplay, sTransType
      ]);

      // 記錄 S1_R3 人員績效
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
            sanming: 0,
            totalQty: 0
          });
        }
        const pStat = r3Map.get(sSalesDisplay);
        if (idxCat === 0) pStat.frameTotal += dSub;
        if (sLensSub === LENS_SUB_SINGLE) pStat.singleLens += dSub;
        if (sLensSub === LENS_SUB_MULTI) pStat.multiLens += dSub;
        if (sLensSub === LENS_SUB_VC) pStat.vcLens += dSub;
        if (idxCat === 1) pStat.longWear += dSub;
        if (idxCat === 2) pStat.okLens += dSub;
        if (idxCat === 4) pStat.vcDaily += dSub;
        if (idxCat === 5) pStat.pharmaDaily += dSub;
        if (idxCat === 6) pStat.sanming += dSub;
        pStat.totalQty += dQty;
      }
    } else if (sBizCat === CAT_MARKETING_ACT) {
      catAmt[7] += dSub; // 行銷折抵
    } else if (sBizCat === CAT_BONUS_REDEEM) {
      catAmt[8] += dSub; // 紅利折抵
    }
  }

  // 組裝 S1_R2 ~ S1_R7
  const r2Rows = buildS1R2(r2Map);
  const r3Rows = buildS1R3(r3Map);
  const { r4Rows, r6Rows, r7Rows } = buildS1R4_6_7(catQty, catAmt, lensSubStats);

  return {
    S1_R1: r1Rows,
    S1_R2: r2Rows,
    S1_R3: r3Rows,
    S1_R4: r4Rows,
    S1_R5: r5Rows,
    S1_R6: r6Rows,
    S1_R7: r7Rows
  };
}

/**
 * 組裝 S1_R2 單據彙整表
 * @param {Map<string, Object>} r2Map - 單據聚合 Map
 * @returns {any[][]} S1_R2 二維矩陣
 */
function buildS1R2(r2Map) {
  const r2Rows = [[
    "銷貨日期", "門銷單號", "三聯單號", "銷售人員",
    "訂單總額(+)", "折扣折抵(-)", "實收淨額"
  ]];

  let sumOrd = 0;
  let sumDisc = 0;
  let sumNet = 0;

  for (const [triNo, info] of r2Map.entries()) {
    r2Rows.push([
      info.date, info.docNo, triNo, info.sales,
      safeRound(info.posAmt, 0),
      safeRound(info.negAmt, 0),
      safeRound(info.netAmt, 0)
    ]);
    sumOrd += info.posAmt;
    sumDisc += info.negAmt;
    sumNet += info.netAmt;
  }

  r2Rows.push([
    "總計", "", `共 ${r2Map.size} 單`, "",
    safeRound(sumOrd, 0),
    safeRound(sumDisc, 0),
    safeRound(sumNet, 0)
  ]);

  return r2Rows;
}

/**
 * 組裝 S1_R3 人員績效統計表（含鏡片三分類：單焦、多焦、視控）
 * @param {Map<string, Object>} r3Map - 人員績效聚合 Map
 * @returns {any[][]} S1_R3 二維矩陣
 */
function buildS1R3(r3Map) {
  const r3Rows = [[
    "銷售人員", "框片總業績", "單焦鏡片", "多焦鏡片", "視控鏡片",
    "OK LENS業績", "長戴業績", "視控日拋業績", "一般藥拋業績",
    "金三明業績", "銷售總件數", "未稅總業績"
  ]];

  let sumFrame = 0, sumSingle = 0, sumMulti = 0, sumVC = 0;
  let sumOK = 0, sumLong = 0, sumVCDaily = 0, sumPharma = 0, sumSanming = 0;
  let sumQty = 0, sumUntaxed = 0;

  for (const [salesName, st] of r3Map.entries()) {
    const personTaxedTotal =
      st.frameTotal + st.longWear + st.okLens +
      st.vcDaily + st.pharmaDaily + st.sanming;
    const personUntaxed = calcUntaxedAmount(personTaxedTotal);

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
      safeRound(st.sanming, 0),
      safeRound(st.totalQty, 0),
      personUntaxed
    ]);

    sumFrame += st.frameTotal;
    sumSingle += st.singleLens;
    sumMulti += st.multiLens;
    sumVC += st.vcLens;
    sumOK += st.okLens;
    sumLong += st.longWear;
    sumVCDaily += st.vcDaily;
    sumPharma += st.pharmaDaily;
    sumSanming += st.sanming;
    sumQty += st.totalQty;
    sumUntaxed += personUntaxed;
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
 * 組裝 S1_R4（品類營收分析）、S1_R6（分類銷售彙整）、S1_R7（分類業績統計）
 * 包含框片總額與縮排之鏡片三分類（單焦、多焦、視控）明細
 * @param {number[]} catQty - 大分類件數陣列
 * @param {number[]} catAmt - 大分類金額陣列
 * @param {Object} lensSubStats - 鏡片三分類統計物件
 * @returns {{r4Rows: any[][], r6Rows: any[][], r7Rows: any[][]}} 三張報表矩陣
 */
function buildS1R4_6_7(catQty, catAmt, lensSubStats) {
  // 計算大類實收毛額（索引 0, 1, 2, 4, 5, 6；索引 3 視控鏡片已含於索引 0 框片中）
  const mainIndices = [0, 1, 2, 4, 5, 6];
  let dGross = 0;
  let dTotalQty = 0;
  for (const idx of mainIndices) {
    dGross += catAmt[idx];
    dTotalQty += catQty[idx];
  }
  const dDiscount = catAmt[7] + catAmt[8];
  const dNet = dGross + dDiscount;

  // 定義顯示列結構（含框片下轄之單焦、多焦、視控三分類縮排項）
  const displayItems = [
    { name: CAT_FRAME_LENS, qty: catQty[0], amt: catAmt[0], note: "含鏡框與全系列鏡片" },
    {
      name: `  └ ${LENS_SUB_SINGLE} (金額已含於框片)`,
      qty: lensSubStats[LENS_SUB_SINGLE].qty,
      amt: lensSubStats[LENS_SUB_SINGLE].amt,
      note: "商品主類：鏡片-單焦 (已剔除視控)"
    },
    {
      name: `  └ ${LENS_SUB_MULTI} (金額已含於框片)`,
      qty: lensSubStats[LENS_SUB_MULTI].qty,
      amt: lensSubStats[LENS_SUB_MULTI].amt,
      note: "商品主類：鏡片-多焦 (已剔除視控)"
    },
    {
      name: `  └ ${LENS_SUB_VC} (金額已含於框片)`,
      qty: lensSubStats[LENS_SUB_VC].qty,
      amt: lensSubStats[LENS_SUB_VC].amt,
      note: "命中 11 組視控關鍵字之近視控制鏡片"
    },
    { name: CAT_LONG_WEAR, qty: catQty[1], amt: catAmt[1], note: "常規硬式/軟式長戴型" },
    { name: CAT_OK_LENS, qty: catQty[2], amt: catAmt[2], note: "角膜塑型片" },
    { name: CAT_VC_DAILY, qty: catQty[4], amt: catAmt[4], note: "視控日拋隱形眼鏡" },
    { name: CAT_PHARMA_DAILY, qty: catQty[5], amt: catAmt[5], note: "一般拋棄式與藥水耗材" },
    { name: CAT_SANMING, qty: catQty[6], amt: catAmt[6], note: "保健食品系列" }
  ];

  const r4Rows = [["營收結構板塊", "實收金額(含稅)", "營業額佔比(%)", "業務備註"]];
  const r6Rows = [["商品業務分類", "銷售總件數", "實收金額"]];
  const r7Rows = [["商品業務分類", "實收金額", "未稅業績"]];

  for (const item of displayItems) {
    const amtRounded = safeRound(item.amt, 0);
    const qtyRounded = safeRound(item.qty, 0);
    const ratio = dGross > 0 ? item.amt / dGross : 0;

    r4Rows.push([item.name, amtRounded, ratio, item.note]);
    r6Rows.push([item.name, qtyRounded, amtRounded]);
    r7Rows.push([item.name, amtRounded, calcUntaxedAmount(amtRounded)]);
  }

  // S1_R4 加上折抵與門市實收淨額總計
  r4Rows.push([CAT_DISCOUNT_ADJ, safeRound(dDiscount, 0), 0, "含紅利與行銷折抵"]);
  r4Rows.push(["門市實收淨額總計", safeRound(dNet, 0), dGross > 0 ? 1 : 0, "大類加總並扣除折抵 (不重複計入鏡片子項)"]);

  // S1_R6 與 S1_R7 總計列
  const grossRounded = safeRound(dGross, 0);
  r6Rows.push(["全店商品總計 (已扣除鏡片子項重複額)", safeRound(dTotalQty, 0), grossRounded]);
  r7Rows.push(["全店商品總計 (已扣除鏡片子項重複額)", grossRounded, calcUntaxedAmount(grossRounded)]);

  return { r4Rows, r6Rows, r7Rows };
}
