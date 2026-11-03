/**
 * 模組名稱：controller.js (主控管線調度與 UI 事件管理模組 V2.3)
 * 職責：管理三插槽檔案拖曳與選取、控制項防呆連動、執行運算管線及 Tab 切換展示
 */

import { parseSourceFile } from "./commonUtils.js";
import { runSalesSubReport } from "./subReportsSales.js";
import { runDepositSubReport } from "./subReportsDeposit.js";
import { parseHistoricalExcelFile, runGrowthSubReport } from "./subReportsGrowth.js";
import {
  REPORT_SEQUENCE,
  renderReportTableHTML,
  exportReportsToExcel
} from "./exportService.js";

/** 應用程式全域狀態物件 */
const appState = {
  slot1Data: null,
  slot2Data: null,
  slot3Data: null,
  masterReportMap: new Map(),
  activeTabKey: ""
};

/**
 * 儀表板初始化進入點
 */
function initDashboard() {
  const slot1Card = document.getElementById("slot1Card");
  const slot2Card = document.getElementById("slot2Card");
  const slot3Card = document.getElementById("slot3Card");
  const fileSlot1 = document.getElementById("fileSlot1");
  const fileSlot2 = document.getElementById("fileSlot2");
  const fileSlot3 = document.getElementById("fileSlot3");
  const btnRun = document.getElementById("btnRun");
  const btnExport = document.getElementById("btnExport");
  const searchInput = document.getElementById("searchInput");

  setupSlotInteractions(slot1Card, fileSlot1, 1);
  setupSlotInteractions(slot2Card, fileSlot2, 2);
  setupSlotInteractions(slot3Card, fileSlot3, 3);

  btnRun.addEventListener("click", executePipeline);
  btnExport.addEventListener("click", () => {
    const hasS1 = appState.slot1Data !== null;
    const hasS2 = appState.slot2Data !== null;
    exportReportsToExcel(appState.masterReportMap, hasS1, hasS2);
  });
  searchInput.addEventListener("input", e => filterCurrentTable(e.target.value));
}

/**
 * 綁定檔案上傳卡片之點擊與拖曳事件
 * @param {HTMLElement} cardEl - 卡片容器元素
 * @param {HTMLInputElement} inputEl - 隱藏之 File Input 元素
 * @param {number} slotNum - 插槽編號 (1、2 或 3)
 */
function setupSlotInteractions(cardEl, inputEl, slotNum) {
  cardEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", async e => {
    if (e.target.files && e.target.files.length > 0) await handleFileLoad(e.target.files[0], slotNum);
  });
  cardEl.addEventListener("dragover", e => { e.preventDefault(); cardEl.classList.add("dragover"); });
  cardEl.addEventListener("dragleave", () => cardEl.classList.remove("dragover"));
  cardEl.addEventListener("drop", async e => {
    e.preventDefault(); cardEl.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) await handleFileLoad(e.dataTransfer.files[0], slotNum);
  });
}

/**
 * 處理檔案載入與解析流程
 * @param {File} file - 使用者上傳之實體檔案
 * @param {number} slotNum - 插槽編號 (1、2 或 3)
 */
async function handleFileLoad(file, slotNum) {
  const cardId = slotNum === 1 ? "slot1Card" : slotNum === 2 ? "slot2Card" : "slot3Card";
  const statusId = slotNum === 1 ? "statusSlot1" : slotNum === 2 ? "statusSlot2" : "statusSlot3";
  const cardEl = document.getElementById(cardId);
  const statusEl = document.getElementById(statusId);

  try {
    statusEl.textContent = "正在解析檔案...";

    if (slotNum === 1) {
      const parsed = await parseSourceFile(file);
      appState.slot1Data = parsed;
      enableSlotCheckboxes(".chk-s1", true, ["S1_RAW", "S1_R6", "S1_STAFF"]);
      cardEl.classList.add("loaded");
      statusEl.textContent = `✓ 已載入：${file.name} (${parsed.rows.length} 筆明細)`;
    } else if (slotNum === 2) {
      const parsed = await parseSourceFile(file);
      appState.slot2Data = parsed;
      enableSlotCheckboxes(".chk-s2", true, ["S2_RAW", "S2_R1", "S2_R2"]);
      cardEl.classList.add("loaded");
      statusEl.textContent = `✓ 已載入：${file.name} (${parsed.rows.length} 筆明細)`;
    } else if (slotNum === 3) {
      const parsed = await parseHistoricalExcelFile(file);
      appState.slot3Data = parsed;
      cardEl.classList.add("loaded");
      statusEl.textContent = `✓ 已載入：${file.name} (讀取分頁：${parsed.sheetName})`;
    }

    // 當 Slot 1 與 Slot 3 同時載入完成時，啟用「成長率」核取方塊
    const canRunGrowth = appState.slot1Data !== null && appState.slot3Data !== null;
    enableSlotCheckboxes(".chk-s3", canRunGrowth, ["S3_GROWTH"]);

    updateActionButtons();
  } catch (err) {
    cardEl.classList.remove("loaded");
    statusEl.textContent = `✗ 載入失敗：${err.message}`;
    alert(`檔案解析錯誤：${err.message}`);
  }
}

/**
 * 啟用或停用指定勾選方塊
 * @param {string} selector - CSS 選擇器字串
 * @param {boolean} enabled - 是否啟用
 * @param {string[]} defaultChecked - 預設勾選之值陣列
 */
function enableSlotCheckboxes(selector, enabled, defaultChecked = []) {
  const boxes = document.querySelectorAll(selector);
  boxes.forEach(box => {
    box.disabled = !enabled;
    if (enabled && defaultChecked.includes(box.value)) box.checked = true;
    else if (!enabled) box.checked = false;
  });
}

/**
 * 更新主動作按鈕狀態
 */
function updateActionButtons() {
  document.getElementById("btnRun").disabled = !(appState.slot1Data || appState.slot2Data);
}

/**
 * 執行報表運算主管線
 */
function executePipeline() {
  try {
    const selectedKeys = new Set();
    document.querySelectorAll(".chk-s1:checked, .chk-s2:checked, .chk-s3:checked").forEach(box => selectedKeys.add(box.value));

    if (selectedKeys.size === 0) {
      alert("請至少勾選一張需要產出的報表！");
      return;
    }

    appState.masterReportMap.clear();

    let s1Results = null;
    if (appState.slot1Data) {
      s1Results = runSalesSubReport(appState.slot1Data);
      for (const [k, v] of Object.entries(s1Results)) {
        if (selectedKeys.has(k)) appState.masterReportMap.set(k, v);
      }
    }

    // 若同時具備 Slot 1 與 Slot 3 且勾選成長率，執行成長率報表運算
    if (appState.slot1Data && appState.slot3Data && selectedKeys.has("S3_GROWTH") && s1Results) {
      const growthMatrix = runGrowthSubReport(appState.slot3Data, s1Results.S1_R6, s1Results.S1_RAW);
      appState.masterReportMap.set("S3_GROWTH", growthMatrix);
    }

    if (appState.slot2Data) {
      const s2Results = runDepositSubReport(appState.slot2Data);
      for (const [k, v] of Object.entries(s2Results)) {
        if (selectedKeys.has(k)) appState.masterReportMap.set(k, v);
      }
    }

    if (appState.masterReportMap.size === 0) {
      alert("無有效報表可供產出！");
      return;
    }

    // 預設預覽焦點優先順序：可銷貨名單 (S2_R1) -> 分類業績報表 (S1_R6) -> 人員業績統計 (S1_STAFF) -> 成長率 (S3_GROWTH) -> 未取件列表 (S2_R2)
    if (appState.masterReportMap.has("S2_R1")) appState.activeTabKey = "S2_R1";
    else if (appState.masterReportMap.has("S1_R6")) appState.activeTabKey = "S1_R6";
    else if (appState.masterReportMap.has("S1_STAFF")) appState.activeTabKey = "S1_STAFF";
    else if (appState.masterReportMap.has("S3_GROWTH")) appState.activeTabKey = "S3_GROWTH";
    else if (appState.masterReportMap.has("S2_R2")) appState.activeTabKey = "S2_R2";
    else {
      const keys = Array.from(appState.masterReportMap.keys()).filter(k => k !== "S1_RAW" && k !== "S2_RAW");
      appState.activeTabKey = keys.length > 0 ? keys[0] : appState.masterReportMap.keys().next().value;
    }

    renderTabsAndActiveTable();
    document.getElementById("reportContainer").style.display = "block";
    document.getElementById("btnExport").disabled = false;
  } catch (err) {
    alert(`運算過程發生錯誤：${err.message}`);
  }
}

/**
 * 渲染分頁按鈕群與作用中表格內容
 */
function renderTabsAndActiveTable() {
  const tabsHeader = document.getElementById("tabsHeader");
  tabsHeader.innerHTML = "";

  for (const item of REPORT_SEQUENCE) {
    // 原始底表僅供匯出，網頁不生成 Tab
    if (item.key === "S1_RAW" || item.key === "S2_RAW") continue;
    if (!appState.masterReportMap.has(item.key)) continue;

    const btn = document.createElement("button");
    btn.className = `tab-btn ${item.key === appState.activeTabKey ? "active" : ""}`;
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      appState.activeTabKey = item.key;
      renderTabsAndActiveTable();
    });
    tabsHeader.appendChild(btn);
  }

  const activeMatrix = appState.masterReportMap.get(appState.activeTabKey);
  const { html, infoText } = renderReportTableHTML(appState.activeTabKey, activeMatrix);

  document.getElementById("tableContainer").innerHTML = html;
  document.getElementById("reportInfo").textContent = infoText;
  document.getElementById("searchInput").value = "";
}

/**
 * 表格內容文字即時過濾篩選
 * @param {string} keyword - 搜尋關鍵字字串
 */
function filterCurrentTable(keyword) {
  const lower = keyword.trim().toLowerCase();
  const rows = document.querySelectorAll("#tableContainer tbody tr");
  rows.forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(lower) ? "" : "none";
  });
}

document.addEventListener("DOMContentLoaded", initDashboard);