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

// Global capture lock to prevent multiple tabs from capturing at the same time
let captureQueue = Promise.resolve(); // Global queue for screenshot captures

// ---- Utility ----
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Enqueue screenshot capture to prevent conflicts when multiple tabs capture simultaneously
function enqueueCaptureJob(tabId, captureFn) {
  console.log(`[CAPTURE-QUEUE] Tab ${tabId} entering capture queue...`);
  const prev = captureQueue;
  const next = prev.then(async () => {
    console.log(`[CAPTURE-QUEUE] Tab ${tabId} starting capture (lock acquired)`);
    try {
      return await captureFn();
    } finally {
      console.log(`[CAPTURE-QUEUE] Tab ${tabId} finished capture (lock released)`);
    }
  }).catch(err => {
    console.error(`[CAPTURE-QUEUE] Capture failed for tab ${tabId}:`, err);
    throw err; // Re-throw to propagate error
  });
  captureQueue = next;
  return next;
}

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
  
  // Load region from storage (critical for service worker persistence)
  let region = null;
  let dpr = 1;
  
  // Check memory first (fast)
  if (CAPTURE_REGIONS.has(tabId)) {
    const cached = CAPTURE_REGIONS.get(tabId);
    region = cached.region;
    dpr = cached.dpr || 1;
    console.log(`[CAPTURE] 📍 Using cached region from memory`);
  } else {
    // Load from storage (service worker may have restarted)
    console.log(`[CAPTURE] 📍 Loading region from storage (service worker may have restarted)...`);
    try {
      const { tabSettings } = await chrome.storage.local.get('tabSettings');
      if (tabSettings && tabSettings[tabId] && tabSettings[tabId].captureRegion) {
        region = tabSettings[tabId].captureRegion;
        dpr = tabSettings[tabId].dpr || 1;
        
        // Restore to memory cache
        CAPTURE_REGIONS.set(tabId, { region, dpr });
        console.log(`[CAPTURE] ✅ Loaded region from storage: ${region.width}x${region.height}`);
      }
    } catch (err) {
      console.warn(`[CAPTURE] ⚠️ Failed to load region from storage:`, err);
    }
  }
  
  // Crop if region is set
  if (region && region.width > 0 && region.height > 0) {
    console.log(`[CAPTURE] 🔲 Cropping to region: ${region.width}x${region.height} (dpr: ${dpr})`);
    imageDataUrl = await cropImage(imageDataUrl, region, dpr);
  } else {
    console.log(`[CAPTURE] ℹ️ No region set, using full screenshot`);
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

// ---- Wait for tab to complete loading (improved) ----
function waitForTabComplete(tabId, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    
    const cleanup = (timer, listener) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
      }
    };
    
    let timer = setTimeout(() => {
      cleanup(timer, listener);
      
      // Instead of rejecting, check if tab is in a usable state
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(`Tab ${tabId} not found: ${chrome.runtime.lastError.message}`));
          return;
        }
        
        if (tab && (tab.status === 'complete' || tab.status === 'loading')) {
          console.log(`[WAIT] ⚠️ Timeout but tab status is "${tab.status}", proceeding anyway...`);
          setTimeout(() => resolve(true), 800);
        } else {
          reject(new Error(`waitForTabComplete timeout after ${timeout}ms, tab status: ${tab?.status || 'unknown'}`));
        }
      });
    }, timeout);
    
    function listener(updatedId, changeInfo, tab) {
      if (updatedId !== tabId) return;
      
      // Accept both 'complete' and stable 'loading' state
      if (changeInfo.status === 'complete') {
        console.log(`[WAIT] ✅ Tab ${tabId} status: complete`);
        cleanup(timer, listener);
        // Extra wait for scripts and content to initialize
        setTimeout(() => resolve(true), 600);
      } else if (changeInfo.status === 'loading' && tab.url && !tab.url.startsWith('chrome://')) {
        // Valid loading state (not chrome:// page)
        console.log(`[WAIT] 📄 Tab ${tabId} loading: ${tab.url.substring(0, 50)}...`);
      }
    }
    
    chrome.tabs.onUpdated.addListener(listener);
    
    // Check initial state immediately
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        cleanup(timer, listener);
        reject(new Error(`Tab ${tabId} not found: ${chrome.runtime.lastError.message}`));
        return;
      }
      
      if (tab?.status === 'complete') {
        console.log(`[WAIT] ✅ Tab ${tabId} already complete`);
        cleanup(timer, listener);
        setTimeout(() => resolve(true), 600);
      } else {
        console.log(`[WAIT] ⏳ Waiting for tab ${tabId} (current status: ${tab?.status || 'unknown'})...`);
      }
    });
  });
}
async function sendToTelegram(botToken, chatId, imageDataUrl, excelBlob = null, customCaption = null, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const photoForm = new FormData();
      photoForm.append('chat_id', chatId);
      const imgBlob = await (await fetch(imageDataUrl)).blob();
      photoForm.append('photo', imgBlob, 'capture.png');
      
      // Use custom caption if provided, otherwise use default timestamp
      const caption = customCaption || `Tự động gửi lúc ${new Date().toLocaleString('vi-VN')}`;
      photoForm.append('caption', caption);

      // Only send photo (Excel sending disabled)
      const photoResp = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: photoForm });

      if (!photoResp.ok) {
        const error = await photoResp.json();
        throw new Error(`Telegram Photo Error: ${error.description || 'Unknown'}`);
      }

      console.log(`[TELEGRAM] ✅ Sent screenshot successfully`);
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
      
      // NOTE: We do NOT focus tab here to avoid conflicts with other auto jobs
      // Tab will only be focused right before screenshot capture
      
      // Check if we should reload (skip reload if this is a retry and tab is already loaded)
      let shouldReload = true;
      if (attempt > 0) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
            console.log(`[JOB] ℹ️ Tab already loaded on retry ${attempt + 1}, skipping reload`);
            shouldReload = false;
          }
        } catch (e) {
          console.warn('[JOB] Could not check tab status:', e.message);
        }
      }
      
      // Reload tab (if needed) - can run in background
      if (shouldReload) {
        console.log(`[JOB] 🔄 Reloading tab ${tabId} (in background)...`);
        await chrome.tabs.reload(tabId, { bypassCache: attempt === 0 }); // Only bypass cache on first attempt
      } else {
        console.log(`[JOB] ⏭️ Skipping reload on retry attempt ${attempt + 1}`);
      }
      
      // Wait for tab to complete with progressive timeout
      const waitTimeout = 6000 + (attempt * 3000); // 6s, 9s, 12s
      console.log(`[JOB] ⏳ Waiting for tab to load (timeout: ${waitTimeout}ms)...`);
      
      try {
        await waitForTabComplete(tabId, waitTimeout);
      } catch (waitErr) {
        console.warn(`[JOB] ⚠️ Wait error: ${waitErr.message}`);
        // Don't fail immediately, try to continue
        console.log(`[JOB] ℹ️ Attempting to continue anyway after ${attempt > 0 ? 'extra' : 'normal'} delay...`);
        await sleep(2000 + attempt * 1000);
      }
      
      // Verify content script is ready
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        console.log(`[JOB] ✅ Content script is ready`);
      } catch (e) {
        console.warn(`[JOB] ⚠️ Content script not responding (may still work):`, e.message);
      }
      
      // Inject date range and apply filters if configured
      const startDate = tabConf.startDate || null;
      const endDate = tabConf.endDate || null;
      
      if (startDate && endDate) {
        console.log(`[JOB] 📅 Applying date range: ${startDate} to ${endDate}`);
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: applyDateRangeFunction,
            args: [startDate, endDate]
          });
          console.log(`[JOB] ✅ Date range applied successfully`);
        } catch (err) {
          console.warn('[JOB] ⚠️ Failed to apply date range:', err.message);
        }
      } else {
        console.log(`[JOB] ℹ️ No date range configured, skipping date filter`);
      }
      
      // NEW STEP: Download Google Sheet if fileName is configured
      const fileName = tabConf.fileName || null;
      let formattedFileName = null; // Will be used for Telegram caption
      
      if (fileName) {
        // Format fileName with current date and time: fileName_DD-MM-YYYY_HH-mm
        const now = new Date();
        const day = String(now.getDate()).padStart(2, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        formattedFileName = `${fileName}_${day}-${month}-${year}_${hours}-${minutes}`;
        
        console.log(`[JOB] 📥 Downloading Google Sheet with name: "${formattedFileName}"`);
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: downloadGoogleSheetFunction,
            args: [formattedFileName]
          });
          console.log(`[JOB] ✅ Google Sheet download initiated successfully`);
          
          // Wait a bit longer for download to complete
          await sleep(2000);
        } catch (err) {
          console.warn('[JOB] ⚠️ Failed to download Google Sheet:', err.message);
          // Continue anyway - don't fail the whole job
        }
      } else {
        console.log(`[JOB] ℹ️ No file name configured, skipping Google Sheet download`);
      }
      
      // CRITICAL: Enqueue capture to prevent conflicts when multiple tabs capture simultaneously
      const imageDataUrl = await enqueueCaptureJob(tabId, async () => {
        // IMPORTANT: Focus tab ONLY before capture to avoid conflicts with other auto jobs
        console.log(`[JOB] 🎯 Focusing tab ${tabId} for screenshot capture...`);
        try {
          const targetTab = await chrome.tabs.get(tabId);
          await chrome.windows.update(targetTab.windowId, { focused: true });
          await chrome.tabs.update(tabId, { active: true });
          await sleep(FOCUS_SWITCH_DELAY); // Wait for tab to fully activate
          console.log(`[JOB] ✅ Tab ${tabId} is now active and ready for capture`);
        } catch (e) {
          console.warn('[JOB] Could not focus tab before capture:', e.message);
        }
        
        // Capture screenshot (with fallback)
        console.log(`[JOB] 📸 Capturing screenshot...`);
        const imageDataUrl = await captureTab(tabId);
        console.log(`[JOB] 📸 Screenshot captured successfully`);
        
        // IMPORTANT: Restore original tab IMMEDIATELY after capture
        // This allows user to continue working while we send to Telegram in background
        if (originalTab && originalTab.id !== tabId) {
          try {
            await sleep(AFTER_CAPTURE_DELAY);
            await chrome.tabs.update(originalTab.id, { active: true });
            console.log(`[JOB] 🔙 Restored original tab ${originalTab.id}`);
          } catch (e) {
            console.warn('[JOB] Could not restore original tab:', e.message);
          }
        }
        
        return imageDataUrl;
      });
      
      // Send to Telegram with custom caption (screenshot only, no Excel)
      // This runs in background after restoring user's tab
      console.log(`[JOB] 📤 Sending screenshot to Telegram...`);
      await sendToTelegram(botToken, chatId, imageDataUrl, null, formattedFileName);
      
      console.log(`[JOB] ✅ Job completed successfully for tab ${tabId}`);
      
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

// ---- Apply Date Range Function (injected into page) ----
// This function is injected and runs IN THE PAGE CONTEXT
async function applyDateRangeFunction(startDateStr, endDateStr) {
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
  
  // Step 1: Click dropdown and fill date range (Start Date & End Date) - with retry
  try {
    await retry(async () => {
      if (!startDateStr || !endDateStr) {
        console.warn('[DATE] ⚠️ No date range provided, skipping');
        return;
      }
      
      console.log(`[DATE] 📅 Setting date range: ${startDateStr} to ${endDateStr}`);
      
      // Step 1.1: Find and click the dropdown button to open date picker popup
      const dropdownBtn = document.querySelector('dropdown-button.menu-trigger.primary-range .button') ||
                         document.querySelector('dropdown-button.primary-range .button') ||
                         document.querySelector('.date-range .button');
      
      if (!dropdownBtn) throw new Error('Dropdown button not found');
      
      console.log('[DATE] 🔽 Clicking dropdown button to open date picker...');
      dropdownBtn.click();
      await delay(500); // Wait for popup to open
      
      // Step 1.2: Wait for date inputs to appear in the popup
      const startInput = await waitForElement('material-input.start.date-input input', 3000);
      if (!startInput) throw new Error('Start date input not found after opening dropdown');
      
      const endInput = document.querySelector('material-input.end.date-input input') ||
                      document.querySelector('.end.date-input input');
      if (!endInput) throw new Error('End date input not found');
      
      console.log('[DATE] ✅ Date picker popup opened, inputs found');
      
      // Helper to format date from yyyy-MM-dd to d/M/yyyy
      const formatDate = (dateStr) => {
        const [year, month, day] = dateStr.split('-');
        return `${parseInt(day)}/${parseInt(month)}/${year}`;
      };
      
      // Step 1.3: Fill start date
      startInput.focus();
      await delay(100);
      startInput.value = formatDate(startDateStr);
      startInput.dispatchEvent(new Event('input', { bubbles: true }));
      startInput.dispatchEvent(new Event('change', { bubbles: true }));
      startInput.blur();
      await delay(300);
      
      console.log(`[DATE] ✅ Filled start date: ${formatDate(startDateStr)}`);
      
      // Step 1.4: Fill end date
      endInput.focus();
      await delay(100);
      endInput.value = formatDate(endDateStr);
      endInput.dispatchEvent(new Event('input', { bubbles: true }));
      endInput.dispatchEvent(new Event('change', { bubbles: true }));
      endInput.blur();
      await delay(300);
      
      console.log(`[DATE] ✅ Filled end date: ${formatDate(endDateStr)}`);
      
      // Step 1.5: Wait for "Áp dụng" button to appear and click it
      const applyBtn = await waitForElement('material-button.apply', 3000);
      if (!applyBtn) throw new Error('Apply button not found');
      
      applyBtn.click();
      await delay(600); // Wait for popup to close and data to load
      console.log('[DATE] ✅ Clicked "Áp dụng" button');
    }, 2, 800);
  } catch (e) {
    console.warn('[DATE] ⚠️ Failed to set date range:', e.message);
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
          console.log('[DATE] ✅ Data loaded (progress indicator hidden)');
          return; // Progress was shown and now hidden - data loaded
        }
        await delay(200);
      }
      
      // If we never saw progress bar, table might already be loaded
      if (!seen) {
        console.log('[DATE] ℹ️ No progress indicator found, assuming data ready');
        return;
      }
      
      throw new Error('Data loading timeout');
    }, 2, 1000);
  } catch (e) {
    console.warn('[DATE] ⚠️ Failed waiting for progress:', e.message);
  }
  
  // Step 3: Scroll to bottom to load all lazy-loaded rows - with retry
  try {
    await retry(async () => {
      const canvas = await waitForElement('.ess-table-canvas', 5000);
      if (!canvas) throw new Error('Table canvas not found');
      
      // Scroll to table first
      canvas.scrollIntoView({ behavior: 'auto', block: 'start' });
      await delay(300);
      
      // Find the scrollable container (canvas itself or parent)
      const scrollContainer = canvas.scrollHeight > canvas.clientHeight ? canvas : 
                             (canvas.parentElement?.scrollHeight > canvas.parentElement?.clientHeight ? canvas.parentElement : null);
      
      if (scrollContainer) {
        console.log('[DATE] 📜 Scrolling to bottom of table to load all rows...');
        
        // Scroll to bottom to trigger lazy loading
        const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
        scrollContainer.scrollTop = maxScrollTop;
        await delay(800); // Wait for lazy load
        
        // Scroll down a bit more to ensure all loaded
        scrollContainer.scrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
        await delay(500);
        
        console.log(`[DATE] ✅ Scrolled to bottom (scrollTop: ${scrollContainer.scrollTop}, scrollHeight: ${scrollContainer.scrollHeight})`);
      } else {
        // If no scrollable container, try window scroll
        console.log('[DATE] 📜 Scrolling window to bottom of table...');
        const tableBottom = canvas.getBoundingClientRect().bottom + window.pageYOffset;
        window.scrollTo({ top: tableBottom, behavior: 'auto' });
        await delay(800);
        console.log('[DATE] ✅ Scrolled window to table bottom');
      }
      
    }, 2, 800);
  } catch (e) {
    console.warn('[DATE] ⚠️ Failed to scroll:', e.message);
  }
  
  // Done - data is now filtered by date range and all rows loaded
  console.log('[DATE] ✅ Date range applied and all data loaded');
  return true;
}

// ---- Download Google Sheet Function ----
async function downloadGoogleSheetFunction(fileName = 'Report') {
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
  
  try {
    console.log('[DOWNLOAD] 📥 Starting Google Sheet download process...');
    
    // Step 1: Find and click the download button (nút "Tải xuống")
    await retry(async () => {
      // Find the specific download button with class "report-download-menu-item"
      let downloadBtn = null;
      
      // Method 1: Most specific - Find by menu class "report-download-menu-item"
      const downloadMenu = document.querySelector('material-menu.report-download-menu-item');
      if (downloadMenu) {
        downloadBtn = downloadMenu.querySelector('material-button.trigger-button');
      }
      
      // Method 2: Direct selector combining class and structure
      if (!downloadBtn) {
        downloadBtn = document.querySelector('toolbelt-material-menu material-menu.report-download-menu-item material-button.trigger-button');
      }
      
      // Method 3: Find in right-panel with specific structure
      if (!downloadBtn) {
        const rightPanel = document.querySelector('toolbelt-bar .right-panel');
        if (rightPanel) {
          const menus = rightPanel.querySelectorAll('material-menu');
          for (const menu of menus) {
            if (menu.classList.contains('report-download-menu-item')) {
              downloadBtn = menu.querySelector('material-button.trigger-button');
              break;
            }
          }
        }
      }
      
      if (!downloadBtn) throw new Error('Download button not found');
      
      console.log('[DOWNLOAD] 🔽 Clicking download button...');
      downloadBtn.click();
      await delay(800); // Wait for popup menu to appear
      console.log('[DOWNLOAD] ✅ Download menu opened');
    }, 3, 1000);
    
    // Step 2: Wait for menu popup and click "Google Trang tính" option
    await retry(async () => {
      // Wait for the menu to appear
      const googleSheetOption = await waitForElement('material-select-item[aria-label="Google Trang tính"]', 5000);
      if (!googleSheetOption) throw new Error('Google Sheets option not found in menu');
      
      console.log('[DOWNLOAD] 📊 Clicking "Google Trang tính" option...');
      googleSheetOption.click();
      await delay(1000); // Wait for dialog to appear
      console.log('[DOWNLOAD] ✅ Google Sheets option selected');
    }, 3, 1000);
    
    // Step 3: Wait for dialog and fill in file name
    await retry(async () => {
      // Wait for the dialog to appear
      const dialog = await waitForElement('material-dialog.basic-dialog', 5000);
      if (!dialog) throw new Error('Download dialog not found');
      
      console.log('[DOWNLOAD] 📝 Dialog appeared, looking for file name input...');
      
      // Find the file name input field
      const fileNameInput = dialog.querySelector('material-input input[type="text"]') ||
                           dialog.querySelector('material-input.themeable input');
      
      if (!fileNameInput) throw new Error('File name input not found in dialog');
      
      console.log(`[DOWNLOAD] ✏️ Filling file name: "${fileName}"...`);
      
      // Clear existing value and set new file name
      fileNameInput.focus();
      await delay(200);
      fileNameInput.value = '';
      await delay(100);
      fileNameInput.value = fileName;
      fileNameInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileNameInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileNameInput.blur();
      await delay(300);
      
      console.log('[DOWNLOAD] ✅ File name filled successfully');
    }, 3, 1000);
    
    // Step 4: Click the final download button in the dialog
    await retry(async () => {
      // Find the "Tải xuống" button in the dialog (btn-yes highlighted)
      const finalDownloadBtn = document.querySelector('material-dialog material-button.btn-yes.highlighted') ||
                              document.querySelector('material-yes-no-buttons material-button.btn-yes') ||
                              Array.from(document.querySelectorAll('material-dialog material-button')).find(btn => 
                                btn.textContent.trim() === 'Tải xuống'
                              );
      
      if (!finalDownloadBtn) throw new Error('Final download button not found');
      
      console.log('[DOWNLOAD] ⬇️ Clicking final "Tải xuống" button...');
      finalDownloadBtn.click();
      await delay(1500); // Wait for download to initiate
      
      console.log('[DOWNLOAD] ✅ Download initiated successfully');
    }, 3, 1000);
    
    console.log('[DOWNLOAD] 🎉 Google Sheet download process completed!');
    return true;
    
  } catch (e) {
    console.error('[DOWNLOAD] ❌ Failed to download Google Sheet:', e.message);
    throw e;
  }
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
