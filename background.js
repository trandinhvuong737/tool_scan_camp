// background.js — Service Worker với Queue, TabCapture Fallback, và Alarms API
importScripts('xlsx.full.min.js');

// Constants
const DEFAULT_RETRY = 2;
const FOCUS_SWITCH_DELAY = 700; // ms đợi sau khi focus tab
const AFTER_CAPTURE_DELAY = 400; // ms đợi trước khi restore tab
const DEFAULT_PAGE_LOAD_TIMEOUT = 3000;

// Task queue per tabId to prevent race condition
const tabQueues = new Map(); // tabId → Promise (queue tail)
const CAPTURE_REGIONS = new Map(); // tabId → { region, dpr }

// ---- Utility ----
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Simple helper to enqueue job per tab
function enqueueTabJob(tabId, jobFn) {
  const prev = tabQueues.get(tabId) || Promise.resolve();
  const next = prev.then(() => jobFn()).catch(err => {
    console.error(`[QUEUE] Job failed for tab ${tabId}:`, err);
  });
  tabQueues.set(tabId, next);
  // Clean up after done
  next.finally(() => {
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  });
  return next;
}

// ---- TabCapture API (không cần focus tab) ----
async function tryTabCapture(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.capture({
        audio: false, 
        video: true, 
        videoConstraints: {
          mandatory: { chromeMediaSource: 'tab' }
        }
      }, stream => {
        if (chrome.runtime.lastError || !stream) {
          reject(new Error('tabCapture not available: ' + (chrome.runtime.lastError?.message || 'no stream')));
          return;
        }
        
        // Convert stream to image
        const video = document.createElement('video');
        video.srcObject = stream;
        video.play().catch(() => {});
        
        video.onloadedmetadata = () => {
          setTimeout(async () => {
            try {
              const canvas = new OffscreenCanvas(video.videoWidth || 1280, video.videoHeight || 720);
              const ctx = canvas.getContext('2d');
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const blob = await canvas.convertToBlob({ type: 'image/png' });
              
              // Stop stream
              stream.getTracks().forEach(t => t.stop());
              
              // Convert blob to dataURL
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = (e) => reject(e);
              reader.readAsDataURL(blob);
            } catch (e) {
              stream.getTracks().forEach(t => t.stop());
              reject(e);
            }
          }, 300);
        };
        
        // Timeout fallback
        setTimeout(() => {
          if (!video.onloadedmetadata) {
            try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
            reject(new Error('tabCapture timeout'));
          }
        }, 3000);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ---- Fallback: Focus tab and capture ----
async function focusAndCapture(tabId) {
  try {
    const targetTab = await chrome.tabs.get(tabId);
    if (!targetTab) throw new Error('Tab not found');
    
    // Store original active tab
    const [active] = await chrome.tabs.query({ active: true, windowId: targetTab.windowId });
    const originalActiveId = active?.id;
    
    // Focus target tab's window then the tab
    await chrome.windows.update(targetTab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    await sleep(FOCUS_SWITCH_DELAY);
    
    // Capture
    const imageDataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(targetTab.windowId, { format: 'png' }, dataUrl => {
        if (chrome.runtime.lastError || !dataUrl) {
          reject(new Error('captureVisibleTab error: ' + (chrome.runtime.lastError?.message || 'no data')));
        } else {
          resolve(dataUrl);
        }
      });
    });
    
    // Restore original active tab
    if (originalActiveId && originalActiveId !== tabId) {
      await sleep(AFTER_CAPTURE_DELAY);
      try {
        await chrome.tabs.update(originalActiveId, { active: true });
      } catch (e) { /* ignore if fail */ }
    }
    
    return imageDataUrl;
  } catch (e) {
    throw e;
  }
}

// ---- Capture with fallback strategy ----
async function captureTab(tabId) {
  console.log(`[CAPTURE] Starting capture for tab ${tabId}`);
  
  let imageDataUrl = null;
  
  // Try tabCapture first (no focus needed)
  try {
    imageDataUrl = await tryTabCapture(tabId);
    console.log(`[CAPTURE] ✅ Success via tabCapture (no focus)`);
  } catch (e) {
    console.warn(`[CAPTURE] ⚠️ tabCapture failed: ${e.message}, trying focus fallback...`);
    imageDataUrl = await focusAndCapture(tabId);
    console.log(`[CAPTURE] ✅ Success via focus fallback`);
  }
  
  // Crop if region is set
  if (CAPTURE_REGIONS.has(tabId)) {
    const { region, dpr } = CAPTURE_REGIONS.get(tabId);
    if (region && region.width > 0 && region.height > 0) {
      console.log(`[CAPTURE] 🔲 Cropping to region: ${region.width}x${region.height}`);
      imageDataUrl = await cropImage(imageDataUrl, region, dpr);
    }
  }
  
  return imageDataUrl;
}

// ---- Crop Image using OffscreenCanvas in Service Worker ----
async function cropImage(imageDataUrl, region, dpr) {
  try {
    const imgRes = await fetch(imageDataUrl);
    const imgBlob = await imgRes.blob();
    const bitmap = await createImageBitmap(imgBlob);
    
    const clipX = region.x * dpr;
    const clipY = region.y * dpr;
    const clipW = region.width * dpr;
    const clipH = region.height * dpr;
    
    const canvas = new OffscreenCanvas(clipW, clipH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, clipX, clipY, clipW, clipH, 0, 0, clipW, clipH);
    
    const clippedBlob = await canvas.convertToBlob({ type: 'image/png' });
    
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(clippedBlob);
    });
  } catch (e) {
    console.error('[CROP] Failed to crop image:', e);
    return imageDataUrl; // Return original if crop fails
  }
}

// ---- Wait for tab to complete loading ----
function waitForTabComplete(tabId, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('waitForTabComplete timeout'));
    }, timeout);
    
    function listener(updatedId, changeInfo) {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small extra wait for scripts to run
        setTimeout(() => resolve(true), 600);
      }
    }
    
    chrome.tabs.onUpdated.addListener(listener);
    
    // Check initial state
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => resolve(true), 600);
      }
    });
  });
}
async function sendToTelegram(botToken, chatId, imageDataUrl, excelBlob = null, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const photoForm = new FormData();
      photoForm.append('chat_id', chatId);
      const imgBlob = await (await fetch(imageDataUrl)).blob();
      photoForm.append('photo', imgBlob, 'capture.png');
      photoForm.append('caption', `Tự động gửi lúc ${new Date().toLocaleString('vi-VN')}`);

      const docPromise = excelBlob ? (async () => {
        const docForm = new FormData();
        docForm.append('chat_id', chatId);
        docForm.append('document', excelBlob, 'data.xlsx');
        const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: docForm });
        if (!resp.ok) {
          const error = await resp.json();
          throw new Error(`Telegram Document Error: ${error.description || 'Unknown'}`);
        }
        return resp;
      })() : null;

      const photoPromise = fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: photoForm });
      const [photoResp, docResp] = await Promise.all([photoPromise, docPromise]);

      if (!photoResp.ok) {
        const error = await photoResp.json();
        throw new Error(`Telegram Photo Error: ${error.description || 'Unknown'}`);
      }

      console.log(`[TELEGRAM] ✅ Sent successfully`);
      return; // Success
      
    } catch (err) {
      console.warn(`[TELEGRAM] Attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt === retries) {
        throw new Error(`Gửi Telegram thất bại sau ${retries} lần thử: ${err.message}`);
      }
      await sleep(2000 * attempt); // Exponential backoff
    }
  }
}

// ---- Main Job Logic with Retry ----
async function runJobForTab(tabId) {
  console.log(`[JOB] ====== Starting job for tab ${tabId} ======`);
  
  const store = await chrome.storage.local.get(['globalSettings', 'tabSettings']);
  const global = store.globalSettings || {};
  const tabConf = store.tabSettings?.[String(tabId)] || {};
  const { botToken } = global;
  const { chatId, pageLoadTimeout = DEFAULT_PAGE_LOAD_TIMEOUT } = tabConf;
  
  if (!botToken || !chatId) {
    console.warn(`[JOB] ⚠️ Missing credentials for tab ${tabId}`);
    return;
  }
  
  console.log(`[JOB] Config - botToken: ✓, chatId: ${chatId}, timeout: ${pageLoadTimeout}ms`);
  
  // Store original active tab to restore later
  let originalTab = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    originalTab = activeTab;
  } catch (e) {
    console.warn('[JOB] Could not get original active tab:', e.message);
  }
  
  // Retry loop
  for (let attempt = 0; attempt <= DEFAULT_RETRY; attempt++) {
    try {
      console.log(`[JOB] 📄 Attempt ${attempt + 1}/${DEFAULT_RETRY + 1}: Preparing tab ${tabId}...`);
      
      // CRITICAL: Focus tab before any operations to avoid background tab issues
      const targetTab = await chrome.tabs.get(tabId);
      await chrome.windows.update(targetTab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      await sleep(FOCUS_SWITCH_DELAY);
      console.log(`[JOB] ✅ Tab ${tabId} is now active and focused`);
      
      // Reload tab
      console.log(`[JOB] 🔄 Reloading tab ${tabId}...`);
      await chrome.tabs.reload(tabId, { bypassCache: true });
      
      // Wait for tab to complete
      await waitForTabComplete(tabId, 4000 + attempt * 1500);
      
      // Verify content script is ready
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        console.log(`[JOB] ✅ Content script is ready`);
      } catch (e) {
        console.warn(`[JOB] ⚠️ Content script not responding (may still work):`, e.message);
      }
      
      // Inject and execute scraping logic (all-in-one) with proper error handling
      console.log(`[JOB] 📊 Scraping data from tab ${tabId}...`);
      let injectResult;
      
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: inlineScrapeFunction
        });
        
        if (!results || results.length === 0) {
          throw new Error('executeScript returned no results');
        }
        
        injectResult = results[0];
        
        if (chrome.runtime.lastError) {
          throw new Error(`Runtime error: ${chrome.runtime.lastError.message}`);
        }
        
      } catch (err) {
        console.error(`[JOB] ❌ Script injection failed for tab ${tabId}:`, err);
        throw new Error(`Failed to inject scraping script: ${err.message}`);
      }
      
      const tableData = injectResult?.result || [];
      console.log(`[JOB] 📊 Scraped ${tableData.length} rows`);
      
      if (!tableData || tableData.length <= 1) {
        throw new Error('No table data found or table is empty');
      }
      
      // Create Excel
      console.log(`[JOB] 📑 Creating Excel file...`);
      const worksheet = XLSX.utils.aoa_to_sheet(tableData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'DataExport');
      const excelArrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const excelBlob = new Blob([excelArrayBuffer], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      });
      console.log(`[JOB] 📑 Excel created, size: ${excelBlob.size} bytes`);
      
      // Ensure tab is still active and visible before capture
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (!currentTab.active) {
          console.log(`[JOB] ⚠️ Tab lost focus, re-activating...`);
          await chrome.tabs.update(tabId, { active: true });
          await sleep(300);
        }
      } catch (e) {
        console.warn('[JOB] Could not verify tab state:', e.message);
      }
      
      // Capture screenshot (with fallback)
      console.log(`[JOB] 📸 Capturing screenshot...`);
      const imageDataUrl = await captureTab(tabId);
      console.log(`[JOB] 📸 Screenshot captured successfully`);
      
      // Send to Telegram
      console.log(`[JOB] 📤 Sending to Telegram...`);
      await sendToTelegram(botToken, chatId, imageDataUrl, excelBlob);
      
      console.log(`[JOB] ✅ Job completed successfully for tab ${tabId}`);
      
      // Restore original tab if different
      if (originalTab && originalTab.id !== tabId) {
        try {
          await sleep(AFTER_CAPTURE_DELAY);
          await chrome.tabs.update(originalTab.id, { active: true });
          console.log(`[JOB] 🔙 Restored original tab ${originalTab.id}`);
        } catch (e) {
          console.warn('[JOB] Could not restore original tab:', e.message);
        }
      }
      
      // Success badge
      chrome.action.setBadgeText({ text: '✓', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50', tabId });
      setTimeout(() => {
        chrome.action.setBadgeText({ text: '', tabId });
      }, 3000);
      
      // Success - exit retry loop
      break;
      
    } catch (err) {
      console.error(`[JOB] ❌ Attempt ${attempt + 1} failed for tab ${tabId}:`, err.message);
      console.error(`[JOB] ❌ Stack:`, err.stack);
      
      // Show error badge
      chrome.action.setBadgeText({ text: '✗', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#F44336', tabId });
      
      if (attempt === DEFAULT_RETRY) {
        // Final attempt failed - restore original tab
        if (originalTab && originalTab.id !== tabId) {
          try {
            await chrome.tabs.update(originalTab.id, { active: true });
          } catch (e) {}
        }
        console.error(`[JOB] ❌ All ${DEFAULT_RETRY + 1} attempts failed for tab ${tabId}`);
      } else {
        // Wait before retry
        await sleep(800 + attempt * 400);
      }
    }
  }
}

// ---- Inline Scraping Function (injected into page) ----
// This function is injected and runs IN THE PAGE CONTEXT
async function inlineScrapeFunction() {
  // Helper functions - must be self-contained
  const delay = ms => new Promise(r => setTimeout(r, ms));
  
  async function waitForSelector(selector, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await delay(200);
    }
    return null;
  }
  
  // MutationObserver-based wait for element (handles dynamic content)
  async function waitForElement(selector, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }
      
      const observer = new MutationObserver((mutations, obs) => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element ${selector} not found after ${timeout}ms`));
      }, timeout);
    });
  }
  
  // Retry wrapper for operations
  async function retry(fn, retries = 3, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (e) {
        console.warn(`[RETRY] Attempt ${i + 1}/${retries} failed:`, e.message);
        if (i === retries - 1) throw e;
        await delay(delayMs * (i + 1));
      }
    }
  }
  
  // Step 1: Select "Hôm nay" (Today) - with retry
  try {
    await retry(async () => {
      const ddBtn = document.querySelector('dropdown-button.menu-trigger.primary-range .button') || 
                    document.querySelector('.date-range .button');
      if (!ddBtn) throw new Error('Dropdown button not found');
      
      ddBtn.click();
      await delay(400);
      
      const today = await waitForElement('material-select-item[aria-label="Hôm nay"]', 3000);
      if (!today) throw new Error('Today option not found');
      
      today.click();
      await delay(400);
      console.log('[SCRAPE] ✅ Selected "Hôm nay"');
    }, 2, 800);
  } catch (e) {
    console.warn('[SCRAPE] ⚠️ Failed to select today:', e.message);
  }
  
  // Step 2: Wait for progress indicator to show then hide (data loading) - with retry
  try {
    await retry(async () => {
      const progSel = 'material-progress,[role="progressbar"]';
      let seen = false;
      const t0 = Date.now();
      
      while (Date.now() - t0 < 12000) {
        const p = document.querySelector(progSel);
        if (p) {
          seen = true;
          await delay(200);
          continue;
        }
        if (seen) {
          console.log('[SCRAPE] ✅ Data loaded (progress indicator hidden)');
          return; // Progress was shown and now hidden - data loaded
        }
        await delay(200);
      }
      
      // If we never saw progress bar, table might already be loaded
      if (!seen) {
        console.log('[SCRAPE] ℹ️ No progress indicator found, assuming data ready');
        return;
      }
      
      throw new Error('Data loading timeout');
    }, 2, 1000);
  } catch (e) {
    console.warn('[SCRAPE] ⚠️ Failed waiting for progress:', e.message);
  }
  
  // Step 3: Wait for table to appear and scroll to it - with retry
  try {
    await retry(async () => {
      const canvas = await waitForElement('.ess-table-canvas', 5000);
      if (!canvas) throw new Error('Table canvas not found');
      
      canvas.scrollIntoView({ behavior: 'auto', block: 'center' });
      await delay(500);
      console.log('[SCRAPE] ✅ Scrolled to table');
    }, 2, 800);
  } catch (e) {
    console.warn('[SCRAPE] ⚠️ Failed to scroll:', e.message);
  }
  
  // Step 4: Scrape table data - with retry
  function scrapeTable() {
    const results = [];
    
    // Find header row
    const headerRow = document.querySelector('.particle-table-header[role="row"]');
    const headers = [];
    const headerMap = {};
    
    if (headerRow) {
      headerRow.querySelectorAll('.particle-table-header-cell[role="columnheader"]').forEach(cell => {
        const key = cell.getAttribute('essfield') || 
                    cell.getAttribute('data-field') || 
                    cell.getAttribute('field');
        let text = cell.getAttribute('aria-label') || 
                   (cell.querySelector('aw-header-cell')?.innerText) || 
                   cell.innerText;
        text = text ? text.trim().replace(/\s+/g, ' ') : '';
        
        if (key && text) {
          headers.push(text);
          headerMap[key] = text;
        }
      });
    }
    
    results.push(headers);
    
    // Find data rows
    const rows = document.querySelectorAll('.ess-table-canvas > div[role="row"]:not(.particle-table-header):not(.summary-draft-overview-row):not(.particle-table-placeholder)');
    
    if (!rows || rows.length === 0) {
      // Fallback to simple table
      const table = document.querySelector('table');
      if (table) {
        return Array.from(table.rows).map(r => 
          Array.from(r.cells).map(c => c.innerText.trim())
        );
      }
      return results;
    }
    
    rows.forEach(row => {
      const map = {};
      row.querySelectorAll('ess-cell[role="gridcell"]').forEach(cell => {
        const k = cell.getAttribute('essfield');
        if (k) map[k] = cell.innerText.trim().replace(/\s+/g, ' ');
      });
      
      const out = headers.map(h => {
        const k = Object.keys(headerMap).find(key => headerMap[key] === h);
        return map[k] || '';
      });
      
      results.push(out);
    });
    
    return results;
  }
  
  // Execute scraping and return results
  return scrapeTable();
}

// ---- Message Handler (using Alarms API instead of setInterval) ----
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  console.log('[MESSAGE] Received:', req.action);
  
  if (req.action === 'startAutoSend') {
    const { tabId, interval } = req;
    console.log(`[MESSAGE] Starting auto send for tab ${tabId}, interval: ${interval} minutes`);
    
    // Start immediate job
    enqueueTabJob(tabId, () => runJobForTab(tabId));
    
    // Create alarm for periodic runs
    chrome.alarms.create(`autoSend_${tabId}`, {
      delayInMinutes: interval,
      periodInMinutes: interval
    });
    
    console.log(`[MESSAGE] Alarm created: autoSend_${tabId}`);
    sendResponse({ status: 'started' });
    return true;
  }
  
  if (req.action === 'stopAutoSend') {
    const { tabId } = req;
    console.log(`[MESSAGE] Stopping auto send for tab ${tabId}`);
    
    chrome.alarms.clear(`autoSend_${tabId}`, (wasCleared) => {
      console.log(`[MESSAGE] Alarm cleared: ${wasCleared}`);
    });
    
    sendResponse({ status: 'stopped' });
    return true;
  }
  
  if (req.action === 'saveCaptureRegion') {
    const { region, dpr } = req;
    const tabId = sender.tab.id;
    console.log(`[MESSAGE] Saving capture region for tab ${tabId}:`, region);
    
    CAPTURE_REGIONS.set(tabId, { region, dpr });
    
    // Save to storage
    chrome.storage.local.get('tabSettings', (data) => {
      const tabSettings = data.tabSettings || {};
      if (!tabSettings[tabId]) tabSettings[tabId] = {};
      tabSettings[tabId].captureRegion = region;
      tabSettings[tabId].dpr = dpr;
      chrome.storage.local.set({ tabSettings });
    });
    
    sendResponse({ status: 'saved' });
    return true;
  }
  
  if (req.action === 'clearCaptureRegion') {
    const { tabId } = req;
    console.log(`[MESSAGE] Clearing capture region for tab ${tabId}`);
    
    CAPTURE_REGIONS.delete(tabId);
    
    chrome.storage.local.get('tabSettings', (data) => {
      const tabSettings = data.tabSettings || {};
      if (tabSettings[tabId]) {
        delete tabSettings[tabId].captureRegion;
        delete tabSettings[tabId].dpr;
        chrome.storage.local.set({ tabSettings });
      }
    });
    
    sendResponse({ status: 'cleared' });
    return true;
  }
  
  return true;
});

// ---- Alarm Handler (for periodic jobs) ----
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log('[ALARM] Triggered:', alarm.name);
  
  if (!alarm.name.startsWith('autoSend_')) return;
  
  const tabId = parseInt(alarm.name.split('_')[1]);
  console.log(`[ALARM] Running job for tab ${tabId}`);
  
  // Enqueue job (prevents race condition)
  enqueueTabJob(tabId, () => runJobForTab(tabId));
});
