/**
 * 模組名稱：controller.js (主控管線調度與 UI 事件管理模組)
 * 職責：管理檔案拖曳與選取、控制項防呆連動、執行運算管線及 Tab 切換展示
 */

import { parseSourceFile } from "./commonUtils.js";
import { runSalesSubReport } from "./subReportsSales.js";
import { runDepositSubReport } from "./subReportsDeposit.js";
import {
  REPORT_SEQUENCE,
  renderReportTableHTML,
  exportReportsToExcel
} from "./exportService.js";

const appState = {
  slot1Data: null,
  slot2Data: null,
  masterReportMap: new Map(),
  activeTabKey: ""
};

function initDashboard() {
  const slot1Card = document.getElementById("slot1Card");
  const slot2Card = document.getElementById("slot2Card");
  const fileSlot1 = document.getElementById("fileSlot1");
  const fileSlot2 = document.getElementById("fileSlot2");
  const btnRun = document.getElementById("btnRun");
  const btnExport = document.getElementById("btnExport");
  const searchInput = document.getElementById("searchInput");

  setupSlotInteractions(slot1Card, fileSlot1, 1);
  setupSlotInteractions(slot2Card, fileSlot2, 2);

  btnRun.addEventListener("click", executePipeline);
  btnExport.addEventListener("click", () => {
    const hasS1 = appState.slot1Data !== null;
    const hasS2 = appState.slot2Data !== null;
    exportReportsToExcel(appState.masterReportMap, hasS1, hasS2);
  });
  searchInput.addEventListener("input", e => filterCurrentTable(e.target.value));
}

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

async function handleFileLoad(file, slotNum) {
  const cardEl = document.getElementById(slotNum === 1 ? "slot1Card" : "slot2Card");
  const statusEl = document.getElementById(slotNum === 1 ? "statusSlot1" : "statusSlot2");

  try {
    statusEl.textContent = "正在解析檔案...";
    const parsed = await parseSourceFile(file);

    if (slotNum === 1) {
      appState.slot1Data = parsed;
      enableSlotCheckboxes(".chk-s1", true, ["S1_RAW", "S1_R6"]);
    } else {
      appState.slot2Data = parsed;
      enableSlotCheckboxes(".chk-s2", true, ["S2_R2", "S2_R3"]);
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

function enableSlotCheckboxes(selector, enabled, defaultChecked = []) {
  const boxes = document.querySelectorAll(selector);
  boxes.forEach(box => {
    box.disabled = !enabled;
    if (enabled && defaultChecked.includes(box.value)) box.checked = true;
    else if (!enabled) box.checked = false;
  });
}

function updateActionButtons() {
  document.getElementById("btnRun").disabled = !(appState.slot1Data || appState.slot2Data);
}

function executePipeline() {
  try {
    const selectedKeys = new Set();
    document.querySelectorAll(".chk-s1:checked, .chk-s2:checked").forEach(box => selectedKeys.add(box.value));

    if (selectedKeys.size === 0) {
      alert("請至少勾選一張需要產出的報表！");
      return;
    }

    appState.masterReportMap.clear();

    if (appState.slot1Data) {
      const s1Results = runSalesSubReport(appState.slot1Data);
      for (const [k, v] of Object.entries(s1Results)) {
        if (selectedKeys.has(k)) appState.masterReportMap.set(k, v);
      }
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

    // 預設焦點切換（S1_R6 優先，其次 S2_R2）
    if (appState.masterReportMap.has("S1_R6")) appState.activeTabKey = "S1_R6";
    else if (appState.masterReportMap.has("S2_R2")) appState.activeTabKey = "S2_R2";
    else {
      // 避開預設選中 S1_RAW
      const keys = Array.from(appState.masterReportMap.keys()).filter(k => k !== "S1_RAW");
      appState.activeTabKey = keys.length > 0 ? keys[0] : appState.masterReportMap.keys().next().value;
    }

    renderTabsAndActiveTable();
    document.getElementById("reportContainer").style.display = "block";
    document.getElementById("btnExport").disabled = false;
  } catch (err) {
    alert(`運算過程發生錯誤：${err.message}`);
  }
}

function renderTabsAndActiveTable() {
  const tabsHeader = document.getElementById("tabsHeader");
  tabsHeader.innerHTML = "";

  for (const item of REPORT_SEQUENCE) {
    // S1_RAW 僅供匯出實體檔案，不提供網頁預覽
    if (item.key === "S1_RAW") continue;
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

function filterCurrentTable(keyword) {
  const lower = keyword.trim().toLowerCase();
  const rows = document.querySelectorAll("#tableContainer tbody tr");
  rows.forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(lower) ? "" : "none";
  });
}

document.addEventListener("DOMContentLoaded", initDashboard);
