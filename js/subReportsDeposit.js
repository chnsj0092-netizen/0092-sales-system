/**
 * 模組名稱：subReportsDeposit.js (Slot 2 訂金未取運算模組)
 * 職責：解析訂金未取貨報表，建構 S2_R1、S2_R2、S2_R3 報表資料結構
 */

import {
  cleanStringVal,
  safeDouble,
  safeRound,
  calcUntaxedAmount,
  formatDateStd,
  padZeroLeft,
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
  CAT_CONTRACT_NO_DETAIL,
  CAT_SYS_REDEEM,
  CAT_PROMO_BUNDLE,
  evaluateUnifiedCategory,
  resolveOrderMajorCategory
} from "./bizRules.js";

/**
 * 將業務分類映射至 S2_R3 的 0~7 槽位索引
 * @param {string} bizCat - 業務分類名稱
 * @returns {number} 槽位索引（-1 代表不計入）
 */
function getS2R3SlotIndex(bizCat) {
  switch (bizCat) {
    case CAT_FRAME_LENS:
    case CAT_PROMO_BUNDLE:
      return 0; // 框片
    case CAT_LONG_WEAR:
      return 1; // 長戴
    case CAT_OK_LENS:
      return 2; // OK LENS
    case CAT_VC_LENS:
      return 3; // 視控鏡片
    case CAT_VC_DAILY:
      return 4; // 視控日拋
    case CAT_PHARMA_DAILY:
      return 5; // 藥拋
    case CAT_SANMING:
      return 6; // 金三明
    case CAT_CONTRACT_NO_DETAIL:
      return 7; // 承件沒有銷售明細
    default:
      return -1;
  }
}

/**
 * 執行 Slot 2 訂金未取報表運算管線
 * @param {{headers: string[], rows: string[][], colMap: Map<string, number>}} parsedData - 解析後之來源資料
 * @returns {Object} 包含 S2_R1, S2_R2, S2_R3 的報表封裝物件
 */
export function runDepositSubReport(parsedData) {
  const { rows, colMap } = parsedData;

  // 1. 檢驗必備欄位
  const reqCols = [
    "訂金日期", "三聯單號", "單據編號", "項次", "會員編號", "會員名稱",
    "中文品名", "數量", "實售價", "金額", "訂金金額", "未付金額",
    "分倉編號", "折射率", "貨號", "備註"
  ];
  const check = validateSchema(colMap, reqCols);
  if (!check.isValid) {
    throw new Error(`訂金未取貨檔案缺少必要欄位：${check.missingMsg}`);
  }

  // 擷取欄位索引
  const cDate = colMap.get("訂金日期");
  const cTriNo = colMap.get("三聯單號");
  const cDocNo = colMap.get("單據編號");
  const cSeq = colMap.get("項次");
  const cMemId = colMap.get("會員編號");
  const cMemName = colMap.get("會員名稱");
  const cItemName = colMap.get("中文品名");
  const cQty = colMap.get("數量");
  const cPrice = colMap.get("實售價");
  const cAmt = colMap.get("金額");
  const cDepAmt = colMap.get("訂金金額");
  const cUnpaidAmt = colMap.get("未付金額");
  const cBranch = colMap.get("分倉編號");
  const cRefr = colMap.get("折射率");
  const cItemCode = colMap.get("貨號");
  const cNote = colMap.get("備註");

  // S2_R1 表頭與資料列容器
  const r1Headers = [
    "訂金日期", "三聯單號", "單據編號", "項次", "會員編號", "會員名稱",
    "業務分類", "是否視控鏡片", "中文品名", "數量", "實售價", "金額",
    "訂金金額", "未付金額", "分倉編號", "折射率", "貨號", "備註"
  ];
  const r1Rows = [r1Headers];

  // S2_R2 單據聚合 Map: key = 三聯單號
  const ordersMap = new Map();

  // S2_R3 8 個分類槽位統計器
  const catQty = new Array(8).fill(0);
  const catAmt = new Array(8).fill(0);
  const catDep = new Array(8).fill(0);
  const catUnpaid = new Array(8).fill(0);
  const catOrdersSet = Array.from({ length: 8 }, () => new Set());

  // 全表總計累加器
  let totalQty = 0;
  let totalAmt = 0;
  let totalDep = 0;
  let totalUnpaid = 0;
  let validRowCount = 0;

  // 遍歷原始明細
  for (const row of rows) {
    const sTriNo = padZeroLeft(row[cTriNo], 12);
    const sItemCode = cleanStringVal(row[cItemCode]);
    if (sTriNo === "" && sItemCode === "") {
      continue;
    }

    validRowCount++;
    const sDate = formatDateStd(row[cDate]);
    const sDocNo = cleanStringVal(row[cDocNo]);
    const sSeq = padZeroLeft(row[cSeq], 4);
    const sMemId = padZeroLeft(row[cMemId], 10);
    const sMemName = cleanStringVal(row[cMemName]);
    const sItemName = cleanStringVal(row[cItemName]);

    const dQty = safeDouble(row[cQty]);
    const dPrice = safeDouble(row[cPrice]);
    const dAmt = safeRound(safeDouble(row[cAmt]), 0);
    const dDepAmt = safeRound(safeDouble(row[cDepAmt]), 0);
    const dUnpaidAmt = safeRound(safeDouble(row[cUnpaidAmt]), 0);

    const sBranch = cleanStringVal(row[cBranch]);
    const sRefr = cleanStringVal(row[cRefr]);
    const sNote = cleanStringVal(row[cNote]);

    // 調用全局統一代碼路由引擎
    const evalRes = evaluateUnifiedCategory(sItemCode, sItemName, dAmt, sRefr);
    const sBizCat = evalRes.category;
    const bIsVCLens = evalRes.isVCLens;

    r1Rows.push([
      sDate, sTriNo, sDocNo, sSeq, sMemId, sMemName,
      sBizCat, bIsVCLens ? "是" : "-", sItemName, dQty, dPrice, dAmt,
      dDepAmt, dUnpaidAmt, sBranch, sRefr, sItemCode, sNote
    ]);

    totalQty += dQty;
    totalAmt += dAmt;
    totalDep += dDepAmt;
    totalUnpaid += dUnpaidAmt;

    // 聚合 1：更新 S2_R2 單據 Map
    if (!ordersMap.has(sTriNo)) {
      const ordCats = new Map();
      if (sBizCat !== "" && sBizCat !== CAT_SYS_REDEEM) {
        ordCats.set(sBizCat, dAmt);
      }
      ordersMap.set(sTriNo, {
        triNo: sTriNo,
        memName: sMemName,
        memId: sMemId,
        ordAmt: dAmt,
        depAmt: dDepAmt,
        unpaidAmt: dUnpaidAmt,
        date: sDate,
        hasContract: sBizCat === CAT_CONTRACT_NO_DETAIL,
        catAmounts: ordCats
      });
    } else {
      const ordInfo = ordersMap.get(sTriNo);
      ordInfo.ordAmt += dAmt;
      ordInfo.depAmt += dDepAmt;
      ordInfo.unpaidAmt += dUnpaidAmt;
      if (sDate !== "" && (ordInfo.date === "" || sDate < ordInfo.date)) {
        ordInfo.date = sDate;
      }
      if (sBizCat === CAT_CONTRACT_NO_DETAIL) {
        ordInfo.hasContract = true;
      }
      if (sBizCat !== "" && sBizCat !== CAT_SYS_REDEEM) {
        const prev = ordInfo.catAmounts.get(sBizCat) || 0;
        ordInfo.catAmounts.set(sBizCat, prev + dAmt);
      }
    }

    // 聚合 2：更新 S2_R3 品類統計槽位
    const slotIdx = getS2R3SlotIndex(sBizCat);
    if (slotIdx >= 0 && slotIdx < 8) {
      catQty[slotIdx] += dQty;
      catAmt[slotIdx] += dAmt;
      catDep[slotIdx] += dDepAmt;
      catUnpaid[slotIdx] += dUnpaidAmt;
      if (sTriNo !== "") {
        catOrdersSet[slotIdx].add(sTriNo);
      }
    }

    // 若為視控鏡片，同步記錄至槽位 3 (視控鏡片獨立縮排子項)
    if (bIsVCLens) {
      catQty[3] += dQty;
      catAmt[3] += dAmt;
      catDep[3] += dDepAmt;
      catUnpaid[3] += dUnpaidAmt;
      if (sTriNo !== "") {
        catOrdersSet[3].add(sTriNo);
      }
    }
  }

  // 寫入 S2_R1 總計列
  r1Rows.push([
    "總計", `共 ${ordersMap.size} 單 / ${validRowCount} 筆`, "", "", "", "",
    "", "", "", totalQty, "", totalAmt,
    totalDep, totalUnpaid, "", "", "", ""
  ]);

  // 建構並排序 S2_R2
  const r2Rows = buildSortedS2R2(ordersMap);

  // 建構 S2_R3
  const r3Rows = buildS2R3Matrix(catQty, catAmt, catDep, catUnpaid, catOrdersSet, ordersMap.size);

  return {
    S2_R1: r1Rows,
    S2_R2: r2Rows,
    S2_R3: r3Rows
  };
}

/**
 * 組裝 S2_R2 未取件列表（A~I 欄固定結構）並執行雙層排序
 * @param {Map<string, Object>} ordersMap - 單據聚合映射表
 * @returns {any[][]} S2_R2 二維矩陣
 */
function buildSortedS2R2(ordersMap) {
  const headers = [
    "三聯單號", "會員名稱", "會員編號", "訂單金額",
    "已收訂金", "尚欠尾款", "未稅總額", "訂單類別", "承件日期"
  ];
  const r2Rows = [headers];

  if (ordersMap.size === 0) {
    r2Rows.push(["總計", "共 0 張單據", "", 0, 0, 0, 0, "", ""]);
    return r2Rows;
  }

  const sortBuf = [];
  for (const info of ordersMap.values()) {
    const dOrdAmt = safeRound(info.ordAmt, 0);
    const dDepAmt = safeRound(info.depAmt, 0);
    const dUnpaidAmt = safeRound(info.unpaidAmt, 0);
    const dUntaxed = calcUntaxedAmount(dOrdAmt);
    const sMajorCat = resolveOrderMajorCategory(dOrdAmt, info.hasContract, info.catAmounts);
    const groupWeight = sMajorCat === CAT_CONTRACT_NO_DETAIL ? 1 : 2;

    sortBuf.push({
      row: [
        info.triNo,
        info.memName,
        info.memId,
        dOrdAmt,
        dDepAmt,
        dUnpaidAmt,
        dUntaxed,
        sMajorCat,
        info.date
      ],
      groupWeight,
      date: info.date,
      ordAmt: dOrdAmt,
      triNo: info.triNo
    });
  }

  // 雙層複合排序：1.承件置頂 -> 2.承件日期昇冪 -> 3.置頂區依金額降冪 / 常規區依三聯單號昇冪
  sortBuf.sort((a, b) => {
    if (a.groupWeight !== b.groupWeight) {
      return a.groupWeight - b.groupWeight;
    }
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    if (a.groupWeight === 1 && a.ordAmt !== b.ordAmt) {
      return b.ordAmt - a.ordAmt;
    }
    return a.triNo.localeCompare(b.triNo);
  });

  let sumOrd = 0;
  let sumDep = 0;
  let sumUnpaid = 0;
  let sumUntaxed = 0;

  for (const item of sortBuf) {
    r2Rows.push(item.row);
    sumOrd += item.row[3];
    sumDep += item.row[4];
    sumUnpaid += item.row[5];
    sumUntaxed += item.row[6];
  }

  r2Rows.push([
    "總計", `共 ${sortBuf.length} 張單據`, "",
    sumOrd, sumDep, sumUnpaid, sumUntaxed, "", ""
  ]);

  return r2Rows;
}

/**
 * 組裝 S2_R3 未取訂金品類分析表（扣除視控重複額之全店總計）
 * @param {number[]} catQty - 各槽位件數
 * @param {number[]} catAmt - 各槽位金額
 * @param {number[]} catDep - 各槽位訂金
 * @param {number[]} catUnpaid - 各槽位未付尾款
 * @param {Set<string>[]} catOrdersSet - 各槽位涉及之三聯單集合
 * @param {number} totalUniqueOrders - 全店不重複單據總數
 * @returns {any[][]} S2_R3 二維矩陣
 */
function buildS2R3Matrix(catQty, catAmt, catDep, catUnpaid, catOrdersSet, totalUniqueOrders) {
  const headers = [
    "商品業務分類", "未取總件數", "涉及訂單數",
    "合約總金額(含稅)", "已收訂金總額", "尚欠尾款總額", "合約金額佔比(%)"
  ];
  const r3Rows = [headers];

  const rowNames = [
    CAT_FRAME_LENS,
    CAT_LONG_WEAR,
    CAT_OK_LENS,
    "  └ 視控鏡片 (金額已含於框片)",
    CAT_VC_DAILY,
    CAT_PHARMA_DAILY,
    CAT_SANMING,
    CAT_CONTRACT_NO_DETAIL
  ];

  let grandQty = 0;
  let grandAmt = 0;
  let grandDep = 0;
  let grandUnpaid = 0;

  // 加總槽位（排除索引 3 之視控鏡片重複額）
  for (let i = 0; i < 8; i++) {
    if (i !== 3) {
      grandQty += catQty[i];
      grandAmt += catAmt[i];
      grandDep += catDep[i];
      grandUnpaid += catUnpaid[i];
    }
  }

  for (let i = 0; i < 8; i++) {
    const ratio = grandAmt > 0 ? catAmt[i] / grandAmt : 0;
    r3Rows.push([
      rowNames[i],
      safeRound(catQty[i], 0),
      catOrdersSet[i].size,
      safeRound(catAmt[i], 0),
      safeRound(catDep[i], 0),
      safeRound(catUnpaid[i], 0),
      ratio
    ]);
  }

  r3Rows.push([
    "全店總計 (已扣除視控重複額)",
    safeRound(grandQty, 0),
    totalUniqueOrders,
    safeRound(grandAmt, 0),
    safeRound(grandDep, 0),
    safeRound(grandUnpaid, 0),
    grandAmt > 0 ? 1 : 0
  ]);

  return r3Rows;
}
