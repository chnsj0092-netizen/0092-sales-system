/**
 * 模組名稱：bizRules.js (全局統一代碼路由與業務規則引擎 V2.3)
 * 職責：純邏輯運算、無 I/O，負責 Slot 1 與 Slot 2 共用之商品分類路由、框片細分判定與決勝規則
 */

import { cleanStringVal } from "./commonUtils.js";

/** 標準商品業務分類常數定義 */
export const CAT_FRAME_LENS = "框片";
export const CAT_LONG_WEAR = "長戴";
export const CAT_OK_LENS = "OK LENS";
export const CAT_VC_LENS = "視控鏡片";
export const CAT_VC_DAILY = "視控日拋";
export const CAT_PHARMA_DAILY = "藥拋";
export const CAT_SANMING = "金三明";

/** 框片細分四子類常數定義（針對新版分類業績報表） */
export const SUB_FRAME = "鏡框";
export const SUB_SINGLE_LENS = "單焦鏡片";
export const SUB_MULTI_LENS = "多焦鏡片";
export const SUB_VC_LENS = "視控鏡片";
export const SUB_NONE = "-";

/** 專案與特殊分類常數定義 */
export const CAT_CONTRACT_NO_DETAIL = "承件沒有銷售明細";
export const CAT_SYS_REDEEM = "系統標記/點數兌換";
export const CAT_PROMO_BUNDLE = "行銷專案";
export const CAT_DISCOUNT_ADJ = "帳務調整與折抵";
export const CAT_BONUS_REDEEM = "紅利折抵";
export const CAT_MARKETING_ACT = "行銷活動";

/** 視控鏡片 11 組標準核心關鍵字清單 */
const VC_LENS_KEYWORDS = [
  "離焦", "新樂學", "成長", "好學生", "視控",
  "星趣控", "小樂園", "邁兒思", "myovision", "miyosmart", "stellest"
];

/**
 * 檢驗鏡片品名是否包含專案標準 11 組視控鏡片核心關鍵字
 * @param {string} itemName - 商品品名
 * @returns {boolean} 是否為視控鏡片
 */
export function isVisionControlLens(itemName) {
  const lowerName = cleanStringVal(itemName).toLowerCase();
  if (lowerName === "") return false;
  return VC_LENS_KEYWORDS.some(kw => lowerName.includes(kw));
}

/**
 * 檢驗拋棄式隱形眼鏡品名是否屬於「視控日拋」
 * @param {string} itemName - 商品品名
 * @returns {boolean} 是否為視控日拋
 */
export function isVisionControlDaily(itemName) {
  const lowerName = cleanStringVal(itemName).toLowerCase();
  if (lowerName === "") return false;
  if (lowerName.includes("misight") || lowerName.includes("邁視")) return true;
  if (lowerName.includes("日拋") && (lowerName.includes("視控") || lowerName.includes("離焦") || lowerName.includes("近視控制"))) return true;
  return false;
}

/**
 * 判定鏡片之細分類（單焦鏡片、多焦鏡片、視控鏡片）
 * @param {string} itemName - 商品品名
 * @param {string} mainCatName - ERP 商品主類名稱
 * @param {string} mainCatCode - ERP 主類編號
 * @returns {{isVCLens: boolean, subCategory: string}} 視控旗標與細分類名稱
 */
export function evaluateLensSubCategory(itemName, mainCatName = "", mainCatCode = "") {
  if (isVisionControlLens(itemName)) {
    return { isVCLens: true, subCategory: SUB_VC_LENS };
  }
  const cleanMainCat = cleanStringVal(mainCatName);
  const cleanMainCode = cleanStringVal(mainCatCode);
  if (cleanMainCat.includes("多焦") || cleanMainCode === "22") {
    return { isVCLens: false, subCategory: SUB_MULTI_LENS };
  }
  return { isVCLens: false, subCategory: SUB_SINGLE_LENS };
}

/**
 * 全局統一代碼路由引擎
 * 【漏洞修正】：
 * 1. G開頭負額不再無條件攔截為行銷活動，先比對自然歸隊(金三明/藥水等)，若無命中且金額為負才列為行銷折抵。
 * 2. 補齊 "藥拋" 關鍵字比對。
 * 3. 0~9 純數字條碼增加 "零件" 關鍵字防呆，校正回歸至框片。
 * @param {string} itemCode - 條碼編號 / 貨號
 * @param {string} itemName - 商品品名 / 中文品名
 * @param {number} amount - 含稅小計 / 金額
 * @param {string} refractive - 折射率
 * @param {string} mainCatName - 商品主類
 * @param {string} mainCatCode - 主類編號
 * @returns {{category: string, isVCLens: boolean, subCategory: string}} 分類結果物件
 */
export function evaluateUnifiedCategory(
  itemCode, itemName, amount, refractive = "", mainCatName = "", mainCatCode = ""
) {
  const code = cleanStringVal(itemCode);
  const name = cleanStringVal(itemName);
  const ref = cleanStringVal(refractive);

  // [規則 8] 純點數折抵優先攔截
  if (code === "7777" || name.includes("紅利折抵")) {
    return { category: CAT_BONUS_REDEEM, isVCLens: false, subCategory: SUB_NONE };
  }
  // [規則 5] 承件款與專案立案
  if (code === "0" || name.includes("本次承件總額")) {
    return { category: amount > 0 ? CAT_CONTRACT_NO_DETAIL : CAT_SYS_REDEEM, isVCLens: false, subCategory: SUB_NONE };
  }

  const firstChar = code.length >= 1 ? code.charAt(0).toUpperCase() : "";
  const secondChar = code.length >= 2 ? code.charAt(1).toUpperCase() : "";

  switch (firstChar) {
    case "A":
      return { category: CAT_FRAME_LENS, isVCLens: false, subCategory: SUB_FRAME };
    case "B": {
      const lensInfo = evaluateLensSubCategory(name, mainCatName, mainCatCode);
      return { category: CAT_FRAME_LENS, isVCLens: lensInfo.isVCLens, subCategory: lensInfo.subCategory };
    }
    case "C":
      return { category: secondChar === "K" ? CAT_OK_LENS : CAT_LONG_WEAR, isVCLens: false, subCategory: SUB_NONE };
    case "I":
      return { category: CAT_SANMING, isVCLens: false, subCategory: SUB_NONE };
    case "G":
      // 優先進行自然歸隊比對
      if (name.includes("三明") || name.includes("金潤明") || name.includes("金晶明") || name.includes("金寶明") || name.includes("金愛爾明")) {
        return { category: CAT_SANMING, isVCLens: false, subCategory: SUB_NONE };
      }
      if (isVisionControlDaily(name)) {
        return { category: CAT_VC_DAILY, isVCLens: false, subCategory: SUB_NONE };
      }
      if (name.includes("藥拋") || name.includes("日拋") || name.includes("月拋") || name.includes("雙週拋") || name.includes("藥水") || name.includes("保養液") || name.includes("緩衝液") || name.includes("沖洗液") || name.includes("舒潤液")) {
        return { category: CAT_PHARMA_DAILY, isVCLens: false, subCategory: SUB_NONE };
      }
      // 若均未命中自然歸隊，且金額小於 0 才判為行銷活動折抵，否則為行銷專案
      if (amount < 0) return { category: CAT_MARKETING_ACT, isVCLens: false, subCategory: SUB_NONE };
      return { category: CAT_PROMO_BUNDLE, isVCLens: false, subCategory: SUB_NONE };

    case "0": case "1": case "2": case "3": case "4":
    case "5": case "6": case "7": case "8": case "9":
      // 數字條碼防呆：若品名含「零件」，校正回框片鏡框
      if (name.includes("零件")) {
        return { category: CAT_FRAME_LENS, isVCLens: false, subCategory: SUB_FRAME };
      }
      return { category: isVisionControlDaily(name) ? CAT_VC_DAILY : CAT_PHARMA_DAILY, isVCLens: false, subCategory: SUB_NONE };
      
    default: {
      if ((ref !== "不分" && ref !== "") || isVisionControlLens(name)) {
        const lensInfo = evaluateLensSubCategory(name, mainCatName, mainCatCode);
        return { category: CAT_FRAME_LENS, isVCLens: lensInfo.isVCLens, subCategory: lensInfo.subCategory };
      }
      return { category: CAT_FRAME_LENS, isVCLens: false, subCategory: SUB_FRAME };
    }
  }
}

/**
 * 判定單筆交易屬性
 * @param {string} bizCat - 業務分類名稱
 * @param {number} qty - 數量
 * @param {number} amount - 含稅小計金額
 * @returns {string} 交易屬性描述
 */
export function getTransactionType(bizCat, qty, amount) {
  if (bizCat === CAT_BONUS_REDEEM) return "紅利折抵";
  if (bizCat === CAT_MARKETING_ACT) return "行銷折抵";
  if (qty < 0 || amount < 0) return "銷退/組合拆項";
  return "一般銷售";
}

/**
 * 計算 S2_R2 單據之「訂單類別」
 * @param {number} orderTotalAmount - 單據含稅總額
 * @param {boolean} hasContractNoDetail - 是否含承件沒有銷售明細
 * @param {Map<string, number>} catAmountsMap - 單據內各分類累計金額映射表
 * @returns {string} 決勝後之訂單類別名稱
 */
export function resolveOrderMajorCategory(orderTotalAmount, hasContractNoDetail, catAmountsMap) {
  if (hasContractNoDetail) return CAT_CONTRACT_NO_DETAIL;
  if (orderTotalAmount <= 0 || !catAmountsMap || catAmountsMap.size === 0) return CAT_SYS_REDEEM;

  const priorityOrder = [
    CAT_OK_LENS, CAT_FRAME_LENS, CAT_LONG_WEAR,
    CAT_SANMING, CAT_VC_DAILY, CAT_PHARMA_DAILY, CAT_PROMO_BUNDLE
  ];

  let bestCat = "";
  let maxAmt = -1;

  for (const catKey of priorityOrder) {
    if (catAmountsMap.has(catKey)) {
      const amt = catAmountsMap.get(catKey);
      if (amt > maxAmt && amt > 0) {
        maxAmt = amt;
        bestCat = catKey;
      }
    }
  }

  if (bestCat === "") {
    for (const [k, amt] of catAmountsMap.entries()) {
      if (amt > maxAmt) {
        maxAmt = amt;
        bestCat = k;
      }
    }
  }
  return bestCat !== "" ? bestCat : CAT_FRAME_LENS;
}