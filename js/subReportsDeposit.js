/**
 * 模組名稱：subReportsDeposit.js (Slot 2 訂金未取運算模組)
 * 職責：解析訂金未取貨報表，建構 S2_R1、S2_R2、S2_R3 報表資料結構
 */

import {
  cleanStringVal, safeDouble, safeRound, calcUntaxedAmount,
  formatDateStd, padZeroLeft, validateSchema
} from "./commonUtils.js";

import {
  CAT_FRAME_LENS, CAT_LONG_WEAR, CAT_OK_LENS, CAT_VC_LENS,
  CAT_VC_DAILY, CAT_PHARMA_DAILY, CAT_SANMING, CAT_CONTRACT_NO_DETAIL,
  CAT_SYS_REDEEM, CAT_PROMO_BUNDLE, evaluateUnifiedCategory, resolveOrderMajorCategory
} from "./bizRules.js";

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

export function runDepositSubReport(parsedData) {
  const { rows, colMap } = parsedData;

  const reqCols = [
    "訂金日期", "三聯單號", "單據編號", "項次", "會員編號", "會員名稱",
    "中文品名", "數量", "實售價", "金額", "訂金金額", "未付金額",
    "分倉編號", "折射率", "貨號", "備註"
  ];
  const check = validateSchema(colMap, reqCols);
  if (!check.isValid) throw new Error(`訂金未取貨檔案缺少必要欄位：${check.missingMsg}`);

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

  const r1Headers = [
    "訂金日期", "三聯單號", "單據編號", "項次", "會員編號", "會員名稱",
    "業務分類", "是否視控鏡片", "中文品名", "數量", "實售價", "金額",
    "訂金金額", "未付金額", "分倉編號", "折射率", "貨號", "備註"
  ];
  const r1Rows = [r1Headers];
  const ordersMap = new Map();

  const catQty = new Array(8).fill(0);
  const catAmt = new Array(8).fill(0);
  const catDep = new Array(8).fill(0);
  const catUnpaid = new Array(8).fill(0);
  const catOrdersSet = Array.from({ length: 8 }, () => new Set());

  let totalQty = 0, totalAmt = 0, totalDep = 0, totalUnpaid = 0, validRowCount = 0;

  for (const row of rows) {
    const sTriNo = padZeroLeft(row[cTriNo], 12);
    const sItemCode = cleanStringVal(row[cItemCode]);
    if (sTriNo === "" && sItemCode === "") continue;

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
    const evalRes = evaluateUnifiedCategory(sItemCode, sItemName, dAmt, sRefr, "", "");
    const sBizCat = evalRes.category;
    const bIsVCLens = evalRes.isVCLens;

    r1Rows.push([
      sDate, sTriNo, sDocNo, sSeq, sMemId, sMemName,
      sBizCat, bIsVCLens ? "是" : "-", sItemName, dQty, dPrice, dAmt,
      dDepAmt, dUnpaidAmt, sBranch, sRefr, sItemCode, sNote
    ]);

    totalQty += dQty; totalAmt += dAmt; totalDep += dDepAmt; totalUnpaid += dUnpaidAmt;

    if (!ordersMap.has(sTriNo)) {
      const ordCats = new Map();
      if (sBizCat !== "" && sBizCat !== CAT_SYS_REDEEM) ordCats.set(sBizCat, dAmt);
      ordersMap.set(sTriNo, {
        triNo: sTriNo, memName: sMemName, memId: sMemId,
        ordAmt: dAmt, depAmt: dDepAmt, unpaidAmt: dUnpaidAmt,
        date: sDate, hasContract: sBizCat === CAT_CONTRACT_NO_DETAIL, catAmounts: ordCats
      });
    } else {
      const ordInfo = ordersMap.get(sTriNo);
      ordInfo.ordAmt += dAmt; ordInfo.depAmt += dDepAmt; ordInfo.unpaidAmt += dUnpaidAmt;
      if (sDate !== "" && (ordInfo.date === "" || sDate < ordInfo.date)) ordInfo.date = sDate;
      if (sBizCat === CAT_CONTRACT_NO_DETAIL) ordInfo.hasContract = true;
      if (sBizCat !== "" && sBizCat !== CAT_SYS_REDEEM) {
        ordInfo.catAmounts.set(sBizCat, (ordInfo.catAmounts.get(sBizCat) || 0) + dAmt);
      }
    }

    const slotIdx = getS2R3SlotIndex(sBizCat);
    if (slotIdx >= 0 && slotIdx < 8) {
      catQty[slotIdx] += dQty; catAmt[slotIdx] += dAmt;
      catDep[slotIdx] += dDepAmt; catUnpaid[slotIdx] += dUnpaidAmt;
      if (sTriNo !== "") catOrdersSet[slotIdx].add(sTriNo);
    }

    if (bIsVCLens) {
      catQty[3] += dQty; catAmt[3] += dAmt;
      catDep[3] += dDepAmt; catUnpaid[3] += dUnpaidAmt;
      if (sTriNo !== "") catOrdersSet[3].add(sTriNo);
    }
  }

  r1Rows.push([
    "總計", `共 ${ordersMap.size} 單 / ${validRowCount} 筆`, "", "", "", "",
    "", "", "", totalQty, "", totalAmt, totalDep, totalUnpaid, "", "", "", ""
  ]);

  return { S2_R1: r1Rows, S2_R2: buildSortedS2R2(ordersMap), S2_R3: buildS2R3Matrix(catQty, catAmt, catDep, catUnpaid, catOrdersSet, ordersMap.size) };
}

function buildSortedS2R2(ordersMap) {
  const headers = ["三聯單號", "會員名稱", "會員編號", "訂單金額", "已收訂金", "尚欠尾款", "未稅總額", "訂單類別", "承件日期"];
  const r2Rows = [headers];
  if (ordersMap.size === 0) {
    r2Rows.push(["總計", "共 0 張單據", "", 0, 0, 0, 0, "", ""]);
    return r2Rows;
  }

  const sortBuf = [];
  for (const info of ordersMap.values()) {
    const dOrdAmt = safeRound(info.ordAmt, 0);
    const dUntaxed = calcUntaxedAmount(dOrdAmt);
    const sMajorCat = resolveOrderMajorCategory(dOrdAmt, info.hasContract, info.catAmounts);
    sortBuf.push({
      row: [info.triNo, info.memName, info.memId, dOrdAmt, safeRound(info.depAmt, 0), safeRound(info.unpaidAmt, 0), dUntaxed, sMajorCat, info.date],
      groupWeight: sMajorCat === CAT_CONTRACT_NO_DETAIL ? 1 : 2,
      date: info.date, ordAmt: dOrdAmt, triNo: info.triNo
    });
  }

  sortBuf.sort((a, b) => {
    if (a.groupWeight !== b.groupWeight) return a.groupWeight - b.groupWeight;
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.groupWeight === 1 && a.ordAmt !== b.ordAmt) return b.ordAmt - a.ordAmt;
    return a.triNo.localeCompare(b.triNo);
  });

  let sumOrd = 0, sumDep = 0, sumUnpaid = 0, sumUntaxed = 0;
  for (const item of sortBuf) {
    r2Rows.push(item.row);
    sumOrd += item.row[3]; sumDep += item.row[4]; sumUnpaid += item.row[5]; sumUntaxed += item.row[6];
  }
  r2Rows.push(["總計", `共 ${sortBuf.length} 張單據`, "", sumOrd, sumDep, sumUnpaid, sumUntaxed, "", ""]);
  return r2Rows;
}

function buildS2R3Matrix(catQty, catAmt, catDep, catUnpaid, catOrdersSet, totalUniqueOrders) {
  const headers = ["商品業務分類", "未取總件數", "涉及訂單數", "合約總金額(含稅)", "已收訂金總額", "尚欠尾款總額", "合約金額佔比(%)"];
  const r3Rows = [headers];
  const rowNames = [CAT_FRAME_LENS, CAT_LONG_WEAR, CAT_OK_LENS, "  └ 視控鏡片 (金額已含於框片)", CAT_VC_DAILY, CAT_PHARMA_DAILY, CAT_SANMING, CAT_CONTRACT_NO_DETAIL];
  let grandQty = 0, grandAmt = 0, grandDep = 0, grandUnpaid = 0;

  for (let i = 0; i < 8; i++) {
    if (i !== 3) {
      grandQty += catQty[i]; grandAmt += catAmt[i]; grandDep += catDep[i]; grandUnpaid += catUnpaid[i];
    }
  }

  for (let i = 0; i < 8; i++) {
    r3Rows.push([rowNames[i], safeRound(catQty[i], 0), catOrdersSet[i].size, safeRound(catAmt[i], 0), safeRound(catDep[i], 0), safeRound(catUnpaid[i], 0), grandAmt > 0 ? catAmt[i] / grandAmt : 0]);
  }
  r3Rows.push(["全店總計 (已扣除視控重複額)", safeRound(grandQty, 0), totalUniqueOrders, safeRound(grandAmt, 0), safeRound(grandDep, 0), safeRound(grandUnpaid, 0), grandAmt > 0 ? 1 : 0]);
  return r3Rows;
}
