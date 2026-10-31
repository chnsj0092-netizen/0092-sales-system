/**
 * 模組名稱：controller.js (主控管線調度與 UI 事件管理模組)
 * 職責：管理檔案拖曳與選取、控制項防呆連動、執行 Slot 1 與 Slot 2 運算管線及 Tab 切換展示
 */

import { parseSourceFile } from "./commonUtils.js";
import { runSalesSubReport } from "./subReportsSales.js";
import { runDepositSubReport } from "./subReportsDeposit.js";
import {
  REPORT_SEQUENCE,
  renderReportTableHTML,
  exportReportsToExcel
} from "./exportService.js";

/** 系統全域狀態儲存物件 */
const appState = {
  slot1Data: null,
  slot2Data: null,
  masterReportMap: new Map(),
  activeTabKey: ""
};

/** 初始化綁定所有介面事件 */
function initDashboard() {
  const slot1Card = document.getElementById("slot1Card");
  const slot2Card = document.getElementById("slot2Card");
  const fileSlot1 = document.getElementById("fileSlot1");
  const fileSlot2 = document.getElementById("fileSlot2");
  const btnRun = document.getElementById("btnRun");
  const btnExport = document.getElementById("btnExport");
  const searchInput = document.getElementById("searchInput");
  const chkExcludeE = document.getElementById("chkExcludeE");

  // 綁定 Slot 1 點擊與拖曳上傳
  setupSlotInteractions(slot1Card, fileSlot1, 1);

  // 綁定 Slot 2 點擊與拖曳上傳
  setupSlotInteractions(slot2Card, fileSlot2, 2);

  // 綁定執行運算按鈕
  btnRun.addEventListener("click", executePipeline);

  // 當切換「排除 E/e 開頭人員」時，若已有運算結果則自動重新運算更新
  chkExcludeE.addEventListener("change", () => {
    if (appState.masterReportMap.size > 0) {
      executePipeline();
    }
  });

  // 綁定匯出 Excel 按鈕
  btnExport.addEventListener("click", () => {
    const hasS1 = appState.slot1Data !== null;
    const hasS2 = appState.slot2Data !== null;
    exportReportsToExcel(appState.masterReportMap, hasS1, hasS2);
  });

  // 綁定表格快速搜尋
  searchInput.addEventListener("input", e => {
    filterCurrentTable(e.target.value);
  });
}

/**
 * 設定單一檔案插槽之點擊與拖曳事件
 * @param {HTMLElement} cardEl - 插槽卡片 DOM 元素
 * @param {HTMLInputElement} inputEl - 隱藏之檔案輸入框元素
 * @param {number} slotNum - 插槽編號 (1 或 2)
 */
function setupSlotInteractions(cardEl, inputEl, slotNum) {
  cardEl.addEventListener("click", () => inputEl.click());

  inputEl.addEventListener("change", async e => {
    if (e.target.files && e.target.files.length > 0) {
      await handleFileLoad(e.target.files[0], slotNum);
    }
  });

  cardEl.addEventListener("dragover", e => {
    e.preventDefault();
    cardEl.classList.add("dragover");
  });

  cardEl.addEventListener("dragleave", () => {
    cardEl.classList.remove("dragover");
  });

  cardEl.addEventListener("drop", async e => {
    e.preventDefault();
    cardEl.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFileLoad(e.dataTransfer.files[0], slotNum);
    }
  });
}

/**
 * 處理檔案讀取與解析，並更新插槽與 CheckBox 狀態
 * @param {File} file - 使用者選取之檔案
 * @param {number} slotNum - 插槽編號 (1 或 2)
 */
async function handleFileLoad(file, slotNum) {
  const cardEl = document.getElementById(slotNum === 1 ? "slot1Card" : "slot2Card");
  const statusEl = document.getElementById(slotNum === 1 ? "statusSlot1" : "statusSlot2");

  try {
    statusEl.textContent = "正在解析檔案...";
    const parsed = await parseSourceFile(file);

    if (slotNum === 1) {
      appState.slot1Data = parsed;
      enableSlotCheckboxes(".chk-s1", true, ["S1_R1", "S1_R2", "S1_R3", "S1_R4", "S1_R5", "S1_R6", "S1_R7"]);
    } else {
      appState.slot2Data = parsed;
      enableSlotCheckboxes(".chk-s2", true, ["S2_R1", "S2_R2", "S2_R3"]);
    }

    cardEl.classList.add("loaded");
    statusEl.textContent = `✓ 已載入：${file.name} (${parsed.rows.length} 筆明細)`;
    updateActionButtons();
  } catch (err) {
    cardEl.classList.remove("loaded");
    statusEl.textContent = `✗ 載入失敗：${err.message}`;
    alert(`檔案解析錯誤：${err.message}`);
  }
}

/**
 * 啟用或停用指定插槽之報表核取方塊
 * @param {string} selector - CheckBox CSS 選擇器
 * @param {boolean} enabled - 是否啟用
 * @param {string[]} defaultChecked - 預設自動勾選之報表代號陣列
 */
function enableSlotCheckboxes(selector, enabled, defaultChecked = []) {
  const boxes = document.querySelectorAll(selector);
  boxes.forEach(box => {
    box.disabled = !enabled;
    if (enabled && defaultChecked.includes(box.value)) {
      box.checked = true;
    } else if (!enabled) {
      box.checked = false;
    }
  });
}

/** 更新主執行按鈕之啟用狀態 */
function updateActionButtons() {
  const btnRun = document.getElementById("btnRun");
  btnRun.disabled = !(appState.slot1Data || appState.slot2Data);
}

/** 執行系統主運算管線並渲染 Tab 與預覽表格 */
function executePipeline() {
  try {
    const excludeE = document.getElementById("chkExcludeE").checked;
    const selectedKeys = new Set();

    document.querySelectorAll(".chk-s1:checked, .chk-s2:checked").forEach(box => {
      selectedKeys.add(box.value);
    });

    if (selectedKeys.size === 0) {
      alert("請至少勾選一張需要產出的報表！");
      return;
    }

    appState.masterReportMap.clear();

    // 執行 Slot 1 運算
    if (appState.slot1Data) {
      const s1Results = runSalesSubReport(appState.slot1Data, excludeE);
      for (const [k, v] of Object.entries(s1Results)) {
        if (selectedKeys.has(k)) {
          appState.masterReportMap.set(k, v);
        }
      }
    }

    // 執行 Slot 2 運算
    if (appState.slot2Data) {
      const s2Results = runDepositSubReport(appState.slot2Data);
      for (const [k, v] of Object.entries(s2Results)) {
        if (selectedKeys.has(k)) {
          appState.masterReportMap.set(k, v);
        }
      }
    }

    if (appState.masterReportMap.size === 0) {
      alert("無有效報表可供產出！");
      return;
    }

    // 設定預設顯示分頁（V1.5 規格：優先顯示 S1_R4，其次 S2_R2）
    if (appState.masterReportMap.has("S1_R4")) {
      appState.activeTabKey = "S1_R4";
    } else if (appState.masterReportMap.has("S2_R2")) {
      appState.activeTabKey = "S2_R2";
    } else {
      appState.activeTabKey = appState.masterReportMap.keys().next().value;
    }

    renderTabsAndActiveTable();
    document.getElementById("reportContainer").style.display = "block";
    document.getElementById("btnExport").disabled = false;
  } catch (err) {
    alert(`運算過程發生錯誤：${err.message}`);
  }
}

/** 渲染分頁標籤列與當前選取之報表表格 */
function renderTabsAndActiveTable() {
  const tabsHeader = document.getElementById("tabsHeader");
  tabsHeader.innerHTML = "";

  for (const item of REPORT_SEQUENCE) {
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
 * 根據輸入之關鍵字即時過濾目前顯示之表格列
 * @param {string} keyword - 搜尋關鍵字
 */
function filterCurrentTable(keyword) {
  const lower = keyword.trim().toLowerCase();
  const rows = document.querySelectorAll("#tableContainer tbody tr");
  rows.forEach(tr => {
    const text = tr.textContent.toLowerCase();
    tr.style.display = text.includes(lower) ? "" : "none";
  });
}

// 啟動初始化
document.addEventListener("DOMContentLoaded", initDashboard);
