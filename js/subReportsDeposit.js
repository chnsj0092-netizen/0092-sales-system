/**
 * 模組名稱：subReportsDeposit.js (Slot 2 訂金未取與可銷貨運算模組 V2.0)
 * 職責：解析訂金未取貨原始資料，建構 S2_RAW 原始中樞、可銷貨名單 (原 S2_R1 替換)、S2_R2 未取件列表與 S2_R3 品類分析
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
 * 映射業務分類至 S2_R3 統計欄位索引 (0~7)
 * @param {string} bizCat - 業務分類名稱
 * @returns {number} 索引編號（-1 代表不列入統計）
 */
function getS2R3SlotIndex(bizCat) {
  switch (bizCat) {
    case CAT_FRAME_LENS:
    case CAT_PROMO_BUNDLE: return 0;
    case CAT_LONG_WEAR: return 1;
    case CAT_OK_LENS: return 2;
    case CAT_VC_LENS: return 3;
    case CAT_VC_DAILY: return 4;
    case CAT_PHARMA_DAILY: return 5;
    case CAT_SANMING: return 6;
    case CAT_CONTRACT_NO_DETAIL: return 7;
    default: return -1;
  }
}

/**
 * 執行 Slot 2 訂金未取資料解析與報表產出核心函式
 * @param {object} parsedData - 由 commonUtils 解析出之原始資料物件 { rows, colMap }
 * @returns {object} 包含 S2_RAW、S2_R1(可銷貨名單)、S2_R2、S2_R3 二維矩陣之物件
 */
export function runDepositSubReport(parsedData) {
  const { rows, colMap } = parsedData;

  // 驗證必要欄位（包含關鍵之庫存量）
  const requiredColumns = [
    "訂金日期", "三聯單號", "單據編號", "項次", "會員編號", "會員名稱",
    "中文品名", "數量", "實售價", "金額", "訂金金額", "未付金額",
    "庫存量", "分倉編號", "折射率", "貨號", "備註"
  ];
  const schemaCheck = validateSchema(colMap, requiredColumns);
  if (!schemaCheck.isValid) {
    throw new Error(`訂金未取貨檔案缺少必要欄位：${schemaCheck.missingMsg}`);
  }

  // 欄位索引映射
  const colDate = colMap.get("訂金日期");
  const colTriNo = colMap.get("三聯單號");
  const colDocNo = colMap.get("單據編號");
  const colSeq = colMap.get("項次");
  const colMemId = colMap.get("會員編號");
  const colMemName = colMap.get("會員名稱");
  const colItemName = colMap.get("中文品名");
  const colQty = colMap.get("數量");
  const colPrice = colMap.get("實售價");
  const colAmt = colMap.get("金額");
  const colDepAmt = colMap.get("訂金金額");
  const colUnpaidAmt = colMap.get("未付金額");
  const colStock = colMap.get("庫存量");
  const colBranch = colMap.get("分倉編號");
  const colRefr = colMap.get("折射率");
  const colItemCode = colMap.get("貨號");
  const colNote = colMap.get("備註");

  // 1. 建置 S2_RAW 原始資料工作表 (25 欄完整底表)
  const rawHeaders = [
    "訂金日期", "會員編號", "會員名稱", "單據編號", "項次", "類別",
    "分倉編號", "折射率", "貨號", "顏色", "呎吋", "中文品名",
    "數量", "實售價", "金額", "訂金金額", "未付金額", "庫存量",
    "對應單據編號", "單據日期", "追加訂金之原單號", "備註",
    "總訂金金額(含追加訂金)", "總未付金額(含追加訂金)", "三聯單號"
  ];
  const s2RawRows = [rawHeaders];

  // 暫存以三聯單號為單位的聚合資料結構
  const ordersAggregationMap = new Map();

  // S2_R3 累計陣列初始化
  const catQty = new Array(8).fill(0);
  const catAmt = new Array(8).fill(0);
  const catDep = new Array(8).fill(0);
  const catUnpaid = new Array(8).fill(0);
  const catOrdersSet = Array.from({ length: 8 }, () => new Set());

  for (const rawRow of rows) {
    const sTriNo = padZeroLeft(rawRow[colTriNo], 12);
    const sItemCode = cleanStringVal(rawRow[colItemCode]);
    if (sTriNo === "" && sItemCode === "") continue;

    const sDate = formatDateStd(rawRow[colDate]);
    const sDocNo = cleanStringVal(rawRow[colDocNo]);
    const sSeq = padZeroLeft(rawRow[colSeq], 4);
    const sMemId = padZeroLeft(rawRow[colMemId], 10);
    const sMemName = cleanStringVal(rawRow[colMemName]);
    const sItemName = cleanStringVal(rawRow[colItemName]);
    const dQty = safeDouble(rawRow[colQty]);
    const dPrice = safeDouble(rawRow[colPrice]);
    const dAmt = safeRound(safeDouble(rawRow[colAmt]), 0);
    const dDepAmt = safeRound(safeDouble(rawRow[colDepAmt]), 0);
    const dUnpaidAmt = safeRound(safeDouble(rawRow[colUnpaidAmt]), 0);
    const dStock = safeDouble(rawRow[colStock]);
    const sBranch = cleanStringVal(rawRow[colBranch]);
    const sRefr = cleanStringVal(rawRow[colRefr]);
    const sNote = cleanStringVal(rawRow[colNote]);

    // 寫入 S2_RAW
    const cleanedRawRow = rawHeaders.map(headerName => {
      const idx = colMap.get(headerName);
      if (idx === undefined || rawRow[idx] === undefined) return "";
      const rawText = cleanStringVal(rawRow[idx]);
      if (headerName.includes("日期")) return formatDateStd(rawText);
      if (headerName === "三聯單號") return padZeroLeft(rawText, 12);
      if (headerName === "會員編號") return padZeroLeft(rawText, 10);
      if (headerName === "項次") return padZeroLeft(rawText, 4);
      if (["數量", "實售價", "金額", "訂金金額", "未付金額", "庫存量", "總訂金金額(含追加訂金)", "總未付金額(含追加訂金)"].includes(headerName)) {
        return safeDouble(rawText);
      }
      return rawText;
    });
    s2RawRows.push(cleanedRawRow);

    // 業務分類計算
    const evalRes = evaluateUnifiedCategory(sItemCode, sItemName, dAmt, sRefr, "", "");
    const sBizCat = evalRes.category;
    const bIsVCLens = evalRes.isVCLens;

    // 聚合單據資料
    if (!ordersAggregationMap.has(sTriNo)) {
      const initialCatAmounts = new Map();
      if (sBizCat !== "" && sBizCat !== CAT_SYS_REDEEM) {
        initialCatAmounts.set(sBizCat, dAmt);
      }
      ordersAggregationMap.set(sTriNo, {
        triNo: sTriNo,
        memName: sMemName,
        memId: sMemId,
        earliestDate: sDate,
        totalAmt: dAmt,
        totalDep: dDepAmt,
        totalUnpaid: dUnpaidAmt,
        hasContract: sBizCat === CAT_CONTRACT_NO_DETAIL,
        catAmounts: initialCatAmounts,
        allItemsUnpaidZero: dUnpaidAmt === 0,
        allItemsStockPositive: dStock > 0
      });
    } else {
      const orderEntry = ordersAggregationMap.get(sTriNo);
      orderEntry.totalAmt += dAmt;
      orderEntry.totalDep += dDepAmt;
      orderEntry.totalUnpaid += dUnpaidAmt;
      if (sDate !== "" && (orderEntry.earliestDate === "" || sDate < orderEntry.earliestDate)) {
        orderEntry.earliestDate = sDate;
      }
      if (sBizCat === CAT_CONTRACT_NO_DETAIL) orderEntry.hasContract = true;
      if (sBizCat !== "" && sBizCat !== CAT_SYS_REDEEM) {
        orderEntry.catAmounts.set(sBizCat, (orderEntry.catAmounts.get(sBizCat) || 0) + dAmt);
      }
      if (dUnpaidAmt !== 0) orderEntry.allItemsUnpaidZero = false;
      if (dStock <= 0) orderEntry.allItemsStockPositive = false;
    }

    // S2_R3 品類統計累加
    const slotIdx = getS2R3SlotIndex(sBizCat);
    if (slotIdx >= 0 && slotIdx < 8) {
      catQty[slotIdx] += dQty;
      catAmt[slotIdx] += dAmt;
      catDep[slotIdx] += dDepAmt;
      catUnpaid[slotIdx] += dUnpaidAmt;
      if (sTriNo !== "") catOrdersSet[slotIdx].add(sTriNo);
    }
    if (bIsVCLens) {
      catQty[3] += dQty;
      catAmt[3] += dAmt;
      catDep[3] += dDepAmt;
      catUnpaid[3] += dUnpaidAmt;
      if (sTriNo !== "") catOrdersSet[3].add(sTriNo);
    }
  }

  // 2. 建置全新【可銷貨名單】 (取代原 S2_R1)
  const deliverableHeaders = ["三聯單號", "姓名", "未稅金額", "含稅金額", "分類"];
  const deliverableRows = [deliverableHeaders];
  const deliverableList = [];

  for (const order of ordersAggregationMap.values()) {
    // 嚴格篩選：所有明細列未付金額均為 0 且庫存量均大於 0
    if (order.allItemsUnpaidZero && order.allItemsStockPositive) {
      const dTaxed = safeRound(order.totalAmt, 0);
      const dUntaxed = calcUntaxedAmount(dTaxed);
      const sResolvedCategory = resolveOrderMajorCategory(dTaxed, order.hasContract, order.catAmounts);

      deliverableList.push({
        triNo: order.triNo,
        name: order.memName,
        untaxed: dUntaxed,
        taxed: dTaxed,
        category: sResolvedCategory,
        date: order.earliestDate
      });
    }
  }

  // 排序：依承件日期由舊到新排序（字串 YYYY/MM/DD 自然遞增）
  deliverableList.sort((itemA, itemB) => {
    if (itemA.date !== itemB.date) {
      return itemA.date.localeCompare(itemB.date);
    }
    return itemA.triNo.localeCompare(itemB.triNo);
  });

  let sumDeliverableUntaxed = 0;
  let sumDeliverableTaxed = 0;
  for (const item of deliverableList) {
    deliverableRows.push([
      item.triNo,
      item.name,
      item.untaxed,
      item.taxed,
      item.category
    ]);
    sumDeliverableUntaxed += item.untaxed;
    sumDeliverableTaxed += item.taxed;
  }

  // 加入總計列
  deliverableRows.push([
    "總計",
    `共 ${deliverableList.length} 筆`,
    sumDeliverableUntaxed,
    sumDeliverableTaxed,
    ""
  ]);

  // 3. 建置 S2_R2 未取件列表與 S2_R3 品類分析表
  const s2R2Rows = buildSortedS2R2(ordersAggregationMap);
  const s2R3Rows = buildS2R3Matrix(catQty, catAmt, catDep, catUnpaid, catOrdersSet, ordersAggregationMap.size);

  return {
    S2_RAW: s2RawRows,
    S2_R1: deliverableRows, // S2_R1 鍵值由可銷貨名單承接
    S2_R2: s2R2Rows,
    S2_R3: s2R3Rows
  };
}

/**
 * 建置 S2_R2 未取件列表（一單一列，雙層排序）
 * @param {Map<string, object>} ordersMap - 訂單聚合字典
 * @returns {any[][]} 二維資料陣列
 */
function buildSortedS2R2(ordersMap) {
  const headers = ["三聯單號", "會員名稱", "會員編號", "訂單金額", "已收訂金", "尚欠尾款", "未稅總額", "訂單類別", "承件日期"];
  const r2Rows = [headers];
  if (ordersMap.size === 0) {
    r2Rows.push(["總計", "共 0 張單據", "", 0, 0, 0, 0, "", ""]);
    return r2Rows;
  }

  const sortBuffer = [];
  for (const info of ordersMap.values()) {
    const dOrdAmt = safeRound(info.totalAmt, 0);
    const dUntaxed = calcUntaxedAmount(dOrdAmt);
    const sMajorCat = resolveOrderMajorCategory(dOrdAmt, info.hasContract, info.catAmounts);
    sortBuffer.push({
      row: [
        info.triNo,
        info.memName,
        info.memId,
        dOrdAmt,
        safeRound(info.totalDep, 0),
        safeRound(info.totalUnpaid, 0),
        dUntaxed,
        sMajorCat,
        info.earliestDate
      ],
      groupWeight: sMajorCat === CAT_CONTRACT_NO_DETAIL ? 1 : 2,
      date: info.earliestDate,
      ordAmt: dOrdAmt,
      triNo: info.triNo
    });
  }

  // 第一群承件總額依金額由大到小；第二群一般單據依承件日期由舊到新
  sortBuffer.sort((itemA, itemB) => {
    if (itemA.groupWeight !== itemB.groupWeight) return itemA.groupWeight - itemB.groupWeight;
    if (itemA.date !== itemB.date) return itemA.date.localeCompare(itemB.date);
    if (itemA.groupWeight === 1 && itemA.ordAmt !== itemB.ordAmt) return itemB.ordAmt - itemA.ordAmt;
    return itemA.triNo.localeCompare(itemB.triNo);
  });

  let sumOrd = 0, sumDep = 0, sumUnpaid = 0, sumUntaxed = 0;
  for (const item of sortBuffer) {
    r2Rows.push(item.row);
    sumOrd += item.row[3];
    sumDep += item.row[4];
    sumUnpaid += item.row[5];
    sumUntaxed += item.row[6];
  }
  r2Rows.push(["總計", `共 ${sortBuffer.length} 張單據`, "", sumOrd, sumDep, sumUnpaid, sumUntaxed, "", ""]);
  return r2Rows;
}

/**
 * 建置 S2_R3 未取訂金品類分析表
 * @param {number[]} catQty - 品類未取數量陣列
 * @param {number[]} catAmt - 品類合約金額陣列
 * @param {number[]} catDep - 品類已收訂金陣列
 * @param {number[]} catUnpaid - 品類尚欠尾款陣列
 * @param {Set<string>[]} catOrdersSet - 品類訂單集合陣列
 * @param {number} totalUniqueOrders - 總獨立訂單數
 * @returns {any[][]} 二維資料陣列
 */
function buildS2R3Matrix(catQty, catAmt, catDep, catUnpaid, catOrdersSet, totalUniqueOrders) {
  const headers = ["商品業務分類", "未取總件數", "涉及訂單數", "合約總金額(含稅)", "已收訂金總額", "尚欠尾款總額", "合約金額佔比(%)"];
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

  let grandQty = 0, grandAmt = 0, grandDep = 0, grandUnpaid = 0;
  for (let i = 0; i < 8; i++) {
    if (i !== 3) {
      grandQty += catQty[i];
      grandAmt += catAmt[i];
      grandDep += catDep[i];
      grandUnpaid += catUnpaid[i];
    }
  }

  for (let i = 0; i < 8; i++) {
    r3Rows.push([
      rowNames[i],
      safeRound(catQty[i], 0),
      catOrdersSet[i].size,
      safeRound(catAmt[i], 0),
      safeRound(catDep[i], 0),
      safeRound(catUnpaid[i], 0),
      grandAmt > 0 ? catAmt[i] / grandAmt : 0
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
