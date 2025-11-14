// background.js — Service Worker với Queue, TabCapture Fallback, và Alarms API

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

// Storage write lock to prevent race condition when multiple tabs write simultaneously
let storageWriteQueue = Promise.resolve();

// Helper to safely write to storage with mutex lock
async function safeStorageWrite(updateFn) {
  const prev = storageWriteQueue;
  const next = prev.then(async () => {
    try {
      return await updateFn();
    } catch (e) {
      console.error('[STORAGE] Write error:', e);
      throw e;
    }
  });
  storageWriteQueue = next;
  return next;
}

// ---- Utility ----
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Safe focus with retry on "tab editing locked" error
async function safeFocusTab(tabId, maxRetries = 3) {
  const targetTab = await chrome.tabs.get(tabId);
  if (!targetTab) throw new Error('Tab not found');
  
  let retries = maxRetries;
  while (retries > 0) {
    try {
      await chrome.windows.update(targetTab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      console.log(`[FOCUS] ✅ Successfully focused tab ${tabId}`);
      return; // Success
    } catch (e) {
      retries--;
      const errorMsg = e.message || '';
      const isTabLocked = errorMsg.includes('user may be dragging') || 
                         errorMsg.includes('cannot be edited') ||
                         errorMsg.includes('Tabs cannot be edited');
      
      if (retries === 0) {
        console.error(`[FOCUS] ❌ Failed to focus tab ${tabId} after ${maxRetries} attempts:`, errorMsg);
        throw e;
      }
      
      if (isTabLocked) {
        const waitTime = 800 + (maxRetries - retries) * 400; // 800ms, 1200ms, 1600ms
        console.warn(`[FOCUS] ⏸️ Tab editing locked, waiting ${waitTime}ms... (${retries} retries left)`);
        await sleep(waitTime);
      } else {
        console.warn(`[FOCUS] ⚠️ Focus error: ${errorMsg}, retrying in 300ms...`);
        await sleep(300);
      }
    }
  }
}

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
    
    // Focus target tab with retry on "tab editing locked"
    await safeFocusTab(tabId, 3);
    
    // Wait for tab to be fully ready and rendered
    await sleep(FOCUS_SWITCH_DELAY);
    
    // Additional wait to ensure GPU rendering completes
    // This fixes "image readback failed" error
    await new Promise(resolve => {
      chrome.tabs.get(tabId, tab => {
        if (tab.status === 'complete') {
          // Tab is complete, wait a bit more for GPU
          setTimeout(resolve, 300);
        } else {
          // Tab not complete yet, wait for it
          const listener = (updTabId, changeInfo) => {
            if (updTabId === tabId && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(resolve, 300);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          // Timeout fallback
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 3000);
        }
      });
    });
    
    // Capture with retry on readback failure and tab editing lock
    let imageDataUrl = null;
    let retries = 10; // Increased from 10 to handle "tab editing locked" state
    while (retries > 0) {
      try {
        imageDataUrl = await new Promise((resolve, reject) => {
          // Capture with highest quality settings
          chrome.tabs.captureVisibleTab(targetTab.windowId, { 
            format: 'png', // PNG for lossless quality
            quality: 100   // Maximum quality (only affects JPEG, but set anyway)
          }, dataUrl => {
            if (chrome.runtime.lastError || !dataUrl) {
              reject(new Error('captureVisibleTab error: ' + (chrome.runtime.lastError?.message || 'no data')));
            } else {
              resolve(dataUrl);
            }
          });
        });
        break; // Success, exit retry loop
      } catch (e) {
        retries--;
        const errorMsg = e.message || '';
        
        // Check if error is "tab editing locked"
        const isTabLocked = errorMsg.includes('user may be dragging') || 
                           errorMsg.includes('cannot be edited') ||
                           errorMsg.includes('Tabs cannot be edited');
        
        if (retries === 0) throw e;
        
        if (isTabLocked) {
          // Wait longer for tab editing lock to release
          const waitTime = 1000 + (5 - retries) * 500; // 1s, 1.5s, 2s, 2.5s, 3s
          console.warn(`[CAPTURE] ⏸️ Tab editing locked, waiting ${waitTime}ms... (${retries} retries left)`);
          await sleep(waitTime);
        } else {
          // Regular retry for other errors
          console.warn(`[CAPTURE] ⚠️ Capture failed: ${errorMsg}, retrying... (${retries} left)`);
          await sleep(500);
        }
      }
    }
    
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
  
  // Note: Upscale disabled - causes blurring. Original resolution gives sharper results.
  
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
    
    // Disable smoothing to preserve sharp pixels (better for screenshots with text)
    ctx.imageSmoothingEnabled = false;
    
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

// ---- Upscale Image for Higher Quality ----
async function upscaleImage(imageDataUrl, scale = 2) {
  try {
    const imgRes = await fetch(imageDataUrl);
    const imgBlob = await imgRes.blob();
    const bitmap = await createImageBitmap(imgBlob);
    
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const newWidth = originalWidth * scale;
    const newHeight = originalHeight * scale;
    
    const canvas = new OffscreenCanvas(newWidth, newHeight);
    const ctx = canvas.getContext('2d');
    
    // Use high-quality image smoothing
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    
    // Draw upscaled image
    ctx.drawImage(bitmap, 0, 0, newWidth, newHeight);
    
    const upscaledBlob = await canvas.convertToBlob({ 
      type: 'image/png',
      quality: 1.0 // Maximum quality
    });
    
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(upscaledBlob);
    });
  } catch (e) {
    console.error('[UPSCALE] Failed to upscale image:', e);
    return imageDataUrl; // Return original if upscale fails
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
      
      // Use sendDocument instead of sendPhoto to preserve original quality
      photoForm.append('document', imgBlob, 'capture.png');
      
      // Use custom caption if provided, otherwise use default timestamp
      const caption = customCaption || `Tự động gửi lúc ${new Date().toLocaleString('vi-VN')}`;
      photoForm.append('caption', caption);

      // Send as document to avoid Telegram compression
      const photoResp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: photoForm });

      if (!photoResp.ok) {
        const error = await photoResp.json();
        throw new Error(`Telegram Document Error: ${error.description || 'Unknown'}`);
      }

      console.log(`[TELEGRAM] ✅ Sent screenshot as document (full quality)`);
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
        console.log(`[JOB] 🔄 Reloading tab ${tabId} (using cache for faster load)...`);
        await chrome.tabs.reload(tabId, { bypassCache: false }); // Always use cache for faster load
      } else {
        console.log(`[JOB] ⏭️ Skipping reload on retry attempt ${attempt + 1}`);
      }
      
      // Wait for tab to complete with progressive timeout
      // Increased timeout for slow networks: 15s, 25s, 40s
      const waitTimeout = 15000 + (attempt * 10000);
      console.log(`[JOB] ⏳ Waiting for tab to load (timeout: ${waitTimeout}ms)...`);
      
      try {
        await waitForTabComplete(tabId, waitTimeout);
        console.log(`[JOB] ✅ Tab loaded successfully`);
      } catch (waitErr) {
        console.warn(`[JOB] ⚠️ Wait error: ${waitErr.message}`);
        // Don't fail immediately, try to continue with extra delay
        console.log(`[JOB] ℹ️ Adding extra delay for slow network...`);
        await sleep(5000 + attempt * 3000); // 5s, 8s, 11s extra wait
      }
      
      // Verify content script is ready
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        console.log(`[JOB] ✅ Content script is ready`);
      } catch (e) {
        console.warn(`[JOB] ⚠️ Content script not responding (may still work):`, e.message);
      }
      
      // Execute automation steps (date range, lop, scroll)
      const startDate = tabConf.startDate || null;
      const endDate = tabConf.endDate || null;
      const enableLop = tabConf.enableLop || false;
      const enableScrollToBottom = tabConf.enableScrollToBottom || false;
      
      // Only run automation if at least one feature is enabled
      if (startDate && endDate || enableLop || enableScrollToBottom) {
        console.log(`[JOB] 🚀 Running automation steps...`);
        console.log(`[JOB] Config: date=${startDate && endDate ? 'Yes' : 'No'}, lop=${enableLop}, scroll=${enableScrollToBottom}`);
        
        // IMPORTANT: Focus tab before running automation
        // This ensures elements are rendered and interactive
        try {
          console.log(`[JOB] 🎯 Focusing tab ${tabId} for automation...`);
          await safeFocusTab(tabId, 3);
          await sleep(FOCUS_SWITCH_DELAY); // Wait for tab to fully activate
          console.log(`[JOB] ✅ Tab ${tabId} is now active for automation`);
        } catch (e) {
          console.warn('[JOB] Could not focus tab for automation:', e.message);
        }
        
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: executeAutomationSteps,
            args: [{
              startDate: startDate,
              endDate: endDate,
              enableLop: enableLop,
              enableScrollToBottom: enableScrollToBottom
            }]
          });
          console.log(`[JOB] ✅ Automation steps executed successfully`);
          
          // CRITICAL: Wait extra time for data to load
          // This is essential for slow networks
          console.log(`[JOB] ⏳ Waiting for data to settle (5s)...`);
          await sleep(5000);
          console.log(`[JOB] ✅ Data should be ready now`);
        } catch (err) {
          console.warn('[JOB] ⚠️ Failed to execute automation steps:', err.message);
          // If automation fails, still wait a bit for page to settle
          await sleep(2000);
        }
      } else {
        console.log(`[JOB] ℹ️ No automation configured, skipping all steps`);
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
        
        // IMPORTANT: Focus tab before downloading (if not already focused from date filter)
        if (!startDate || !endDate) {
          try {
            console.log(`[JOB] 🎯 Focusing tab ${tabId} for download interaction...`);
            await safeFocusTab(tabId, 3);
            await sleep(FOCUS_SWITCH_DELAY);
            console.log(`[JOB] ✅ Tab ${tabId} is now active for download`);
          } catch (e) {
            console.warn('[JOB] Could not focus tab for download:', e.message);
          }
        } else {
          console.log(`[JOB] ℹ️ Tab already focused from date filter step`);
        }
        
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
          await safeFocusTab(tabId, 3);
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

// ---- Page Automation Steps (injected into page) ----
// This function is injected and runs IN THE PAGE CONTEXT

// Main orchestrator function - define execution order here
async function executeAutomationSteps(config) {
  // Helper functions - must be self-contained
  const delay = ms => new Promise(r => setTimeout(r, ms));
  
  async function waitForElement(selector, timeout = 15000) {
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
  
  // ========== STEP FUNCTIONS ==========
  
  // Step 0: Wait for page to be ready
  async function stepWaitForPageReady() {
    console.log('[STEP-0] ⏳ Waiting for Angular UI to be fully rendered...');
    try {
      const dropdownButton = await waitForElement(
        'dropdown-button.menu-trigger.primary-range .button, dropdown-button.primary-range .button, .date-range .button',
        20000
      );
      
      if (dropdownButton) {
        console.log('[STEP-0] ✅ UI fully rendered - dropdown button detected');
        await delay(2000);
      } else {
        console.log('[STEP-0] ⚠️ Dropdown button not found, but continuing with extra delay...');
        await delay(3000);
      }
    } catch (e) {
      console.warn('[STEP-0] ⚠️ UI check failed:', e.message);
      console.log('[STEP-0] ⏳ Adding extra 5 second delay for slow loading...');
      await delay(5000);
    }
  }
  
  // Step 1: Apply date range filter
  async function stepApplyDateRange(startDateStr, endDateStr) {
    if (!startDateStr || !endDateStr) {
      console.log('[STEP-1] ℹ️ No date range provided, skipping');
      return;
    }
    
    console.log('[STEP-1] 📅 Applying date range filter...');
    
    try {
      await retry(async () => {
        console.log(`[STEP-1] Setting date range: ${startDateStr} to ${endDateStr}`);
        
        // Find and click dropdown button
        const dropdownBtn = await waitForElement('dropdown-button.menu-trigger.primary-range .button', 10000) ||
                            await waitForElement('dropdown-button.primary-range .button', 5000) ||
                            await waitForElement('.date-range .button', 5000);
        
        if (!dropdownBtn) throw new Error('Dropdown button not found');
        
        console.log('[STEP-1] ✅ Dropdown button found');
        await delay(2000);
        
        dropdownBtn.click();
        await delay(800);
        
        // Wait for date inputs
        const startInput = await waitForElement('material-input.start.date-input input', 3000);
        if (!startInput) throw new Error('Start date input not found');
        
        const endInput = document.querySelector('material-input.end.date-input input') ||
                        document.querySelector('.end.date-input input');
        if (!endInput) throw new Error('End date input not found');
        
        console.log('[STEP-1] ✅ Date picker opened');
        
        // Format date helper
        const formatDate = (dateStr) => {
          const [year, month, day] = dateStr.split('-');
          return `${parseInt(day)}/${parseInt(month)}/${year}`;
        };
        
        // Fill start date
        startInput.focus();
        await delay(100);
        startInput.value = formatDate(startDateStr);
        startInput.dispatchEvent(new Event('input', { bubbles: true }));
        startInput.dispatchEvent(new Event('change', { bubbles: true }));
        startInput.blur();
        await delay(300);
        
        console.log(`[STEP-1] ✅ Filled start date: ${formatDate(startDateStr)}`);
        
        // Fill end date
        endInput.focus();
        await delay(100);
        endInput.value = formatDate(endDateStr);
        endInput.dispatchEvent(new Event('input', { bubbles: true }));
        endInput.dispatchEvent(new Event('change', { bubbles: true }));
        endInput.blur();
        await delay(300);
        
        console.log(`[STEP-1] ✅ Filled end date: ${formatDate(endDateStr)}`);
        
        // Click apply button
        const applyBtn = await waitForElement('material-button.apply', 3000);
        if (!applyBtn) throw new Error('Apply button not found');
        
        applyBtn.click();
        await delay(600);
        console.log('[STEP-1] ✅ Clicked "Áp dụng" button');
      }, 2, 800);
    } catch (e) {
      console.warn('[STEP-1] ⚠️ Failed to set date range:', e.message);
    }
  }
  
  // Step 2: Wait for data to load
  async function stepWaitForDataLoad() {
    console.log('[STEP-2] ⏳ Waiting for data to load...');
    
    try {
      await retry(async () => {
        const progSel = 'material-progress,[role="progressbar"]';
        let seen = false;
        let noProgressCounter = 0;
        const t0 = Date.now();
        
        while (Date.now() - t0 < 10000) {
          const p = document.querySelector(progSel);
          if (p) {
            seen = true;
            noProgressCounter = 0;
            await delay(200);
            continue;
          }
          
          if (seen) {
            console.log('[STEP-2] ✅ Data loaded (progress indicator hidden)');
            await delay(500);
            return;
          }
          
          noProgressCounter++;
          if (noProgressCounter > 15) {
            console.log('[STEP-2] ℹ️ No progress indicator found after 3s, assuming data ready');
            return;
          }
          
          await delay(200);
        }
        
        if (!seen) {
          console.log('[STEP-2] ⚠️ Progress timeout, proceeding anyway...');
          return;
        }
        
        throw new Error('Data loading timeout after 10s');
      }, 2, 1000);
    } catch (e) {
      console.warn('[STEP-2] ⚠️ Failed waiting for progress:', e.message);
    }
  }
  
  // Step 3: Apply Lop (Layer) selection
  async function stepApplyLop() {
    console.log('[STEP-3] 🔄 Applying Lop (Layer) selection...');
    
    try {
      // Wait for "Lớp" button
      const lopButton = await waitForElement('layers material-button.btn', 10000)
        .catch(() => document.querySelector('material-button[aria-label="Lớp"]'))
        .catch(() => document.querySelector('material-button .icon[icon="layers"]')?.closest('material-button'));
      
      if (!lopButton) {
        console.warn('[STEP-3] ⚠️ Lop button not found');
        return;
      }
      
      console.log('[STEP-3] ✅ "Lớp" button found');
      await delay(2000);
      
      lopButton.click();
      await delay(1500);
      
      // Wait for popup
      const popup = await waitForElement('.popup-wrapper.visible[role="dialog"]', 5000);
      console.log('[STEP-3] ✅ Popup appeared');
      
      // Find currency option
      const items = Array.from(document.querySelectorAll('material-select-item'));
      const currencyItem = items.find(item => 
        item.textContent.trim().includes('Đơn vị tiền tệ đã chuyển đổi')
      );
      
      if (!currencyItem) {
        console.warn('[STEP-3] ⚠️ Currency option not found');
        return;
      }
      
      // Check if already selected
      const checkbox = currencyItem.querySelector('material-checkbox');
      const isChecked = checkbox?.getAttribute('aria-checked') === 'true';
      
      if (!isChecked) {
        console.log('[STEP-3] ☑️ Selecting currency option...');
        currencyItem.click();
        await delay(500);
      } else {
        console.log('[STEP-3] ℹ️ Currency option already selected');
      }
      
      // Find and click apply button
      await delay(1000);
      
      const mainDiv = popup.querySelector('.main');
      let applyButton = mainDiv?.querySelector('.wrapper material-button[raised]') ||
                       popup.querySelector('material-button[raised]');
      
      if (!applyButton) {
        const allButtons = document.querySelectorAll('material-button, button');
        applyButton = Array.from(allButtons).find(btn => {
          const text = btn.textContent.trim();
          const isVisible = btn.offsetParent !== null;
          return (text === 'Áp dụng' || text.includes('Áp dụng')) && isVisible;
        });
      }
      
      if (!applyButton) {
        console.warn('[STEP-3] ⚠️ Apply button not found');
        return;
      }
      
      console.log('[STEP-3] 🖱️ Clicking apply button...');
      applyButton.click();
      await delay(100);
      applyButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await delay(1500);
      
      console.log('[STEP-3] ✅ Lop selection completed');
    } catch (e) {
      console.warn('[STEP-3] ⚠️ Failed to apply Lop:', e.message);
    }
  }
  
  // Step 4: Scroll to bottom
  async function stepScrollToBottom() {
    console.log('[STEP-4] 📜 Scrolling to bottom...');
    
    try {
      const contentContainer = document.querySelector('awsm-child-content') ||
                              document.querySelector('.awsm-content') ||
                              document.querySelector('.awsm-nav-bar-and-content');
      
      if (contentContainer) {
        const scrollHeight = contentContainer.scrollHeight;
        const clientHeight = contentContainer.clientHeight;
        const scrollDistance = scrollHeight - clientHeight;
        
        console.log(`[STEP-4] 📊 Container: scrollHeight=${scrollHeight}, clientHeight=${clientHeight}, needScroll=${scrollDistance}px`);
        
        if (scrollDistance > 10) {
          // Use larger deltaY and more events to ensure we reach the bottom
          const deltaPerEvent = 500; // Increased from 200
          const wheelCount = Math.ceil(scrollDistance / deltaPerEvent) + 10; // Add extra events to ensure reaching bottom
          
          console.log(`[STEP-4] 🎯 Dispatching ${wheelCount} wheel events (${deltaPerEvent}px each)...`);
          
          // Dispatch events in batches with small delays
          for (let i = 0; i < wheelCount; i++) {
            contentContainer.dispatchEvent(new WheelEvent('wheel', {
              deltaY: deltaPerEvent,
              bubbles: true,
              cancelable: true
            }));
            
            // Small delay every 5 events to allow scroll to process
            if (i % 5 === 0 && i > 0) {
              await delay(50);
            }
          }
          
          // Wait longer for scroll animation and lazy loading
          await delay(3000);
          
          // Verify if we reached the bottom
          const finalScrollTop = contentContainer.scrollTop;
          const maxScroll = scrollHeight - clientHeight;
          console.log(`[STEP-4] 📍 Final scroll position: ${finalScrollTop}/${maxScroll}px`);
          
          if (finalScrollTop >= maxScroll - 50) {
            console.log(`[STEP-4] ✅ Reached bottom successfully`);
          } else {
            console.log(`[STEP-4] ⚠️ Partially scrolled (${Math.round(finalScrollTop / maxScroll * 100)}%)`);
          }
        } else {
          console.log('[STEP-4] ℹ️ No scroll needed (content fits in view)');
        }
      } else {
        console.warn('[STEP-4] ⚠️ Content container not found');
      }
    } catch (e) {
      console.warn('[STEP-4] ⚠️ Failed to scroll:', e.message);
    }
  }
  
  // ========== EXECUTION ORDER ==========
  // Define the sequence of steps here - easy to reorder!
  
  console.log('[AUTO] 🚀 Starting automation sequence...');
  
  // Always wait for page ready first
  await stepWaitForPageReady();
  
  // Apply date range if configured
  if (config.startDate && config.endDate) {
    await stepApplyDateRange(config.startDate, config.endDate);
    await stepWaitForDataLoad();
  }
  
  // Apply Lop (Layer) selection if enabled
  if (config.enableLop) {
    await stepApplyLop();
  }
  
  // Scroll to bottom if enabled (AFTER Lop)
  if (config.enableScrollToBottom) {
    await stepScrollToBottom();
  }
  
  console.log('[AUTO] ✅ Automation sequence completed');
  return true;
}

// ---- Apply Lop (Layer) Function - Select "Converted Currency" ----
async function applyLopFunction() {
  // Helper functions - must be self-contained
  const delay = ms => new Promise(r => setTimeout(r, ms));
  
  async function waitForElement(selector, timeout = 5000) {
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
        reject(new Error(`Element not found: ${selector}`));
      }, timeout);
    });
  }
  
  console.log('[LOP] 🔄 Starting Lop (Layer) selection...');
  
  try {
    // Step 1: Wait for "Lớp" button to be ready (page must be loaded first)
    console.log('[LOP] ⏳ Waiting for page to load and "Lớp" button to appear...');
    
    const lopButton = await waitForElement('layers material-button.btn', 10000)
      .catch(() => document.querySelector('material-button[aria-label="Lớp"]'))
      .catch(() => document.querySelector('material-button .icon[icon="layers"]')?.closest('material-button'));
    
    if (!lopButton) {
      throw new Error('Lop button not found after waiting 10s');
    }
    
    console.log('[LOP] ✅ "Lớp" button found and ready');
    
    // Extra wait to ensure Angular framework is fully initialized
    await delay(2000);
    
    console.log('[LOP] 🖱️ Clicking "Lớp" button...');
    lopButton.click();
    await delay(1500); // Increased wait for popup to appear and render
    
    // Step 2: Wait for popup to appear
    const popup = await waitForElement('.popup-wrapper.visible[role="dialog"]', 5000);
    console.log('[LOP] ✅ Popup appeared');
    
    // Also check what's inside
    const popupContent = popup.querySelector('.main, .content, .material-popup-content');
    
    // Step 3: Find and click "Đơn vị tiền tệ đã chuyển đổi" checkbox
    // Look for the material-select-item containing the text
    const items = Array.from(document.querySelectorAll('material-select-item'));
    const currencyItem = items.find(item => 
      item.textContent.trim().includes('Đơn vị tiền tệ đã chuyển đổi')
    );
    
    if (!currencyItem) {
      throw new Error('Currency option not found');
    }
    
    // Check if already selected
    const checkbox = currencyItem.querySelector('material-checkbox');
    const isChecked = checkbox?.getAttribute('aria-checked') === 'true';
    
    if (isChecked) {
      console.log('[LOP] ℹ️ Currency option already selected, skipping...');
    } else {
      console.log('[LOP] ☑️ Selecting "Đơn vị tiền tệ đã chuyển đổi"...');
      currencyItem.click();
      await delay(500);
    }
    
    // Step 4: Click "Áp dụng" button - based on actual HTML structure
    console.log('[LOP] 🔍 Looking for "Áp dụng" button...');
    
    // Wait a bit for button to be ready
    await delay(1000);
    
    // Try multiple selectors for the apply button
    let applyButton = null;
    
    // Method 1: MOST SPECIFIC - Search in .wrapper inside .main (based on actual HTML structure)
    // <div class="main"><div class="wrapper"><material-button raised="">Áp dụng</material-button></div></div>
    const mainDiv = popup.querySelector('.main');
    if (mainDiv) {
      const wrapper = mainDiv.querySelector('.wrapper');
      if (wrapper) {
        applyButton = wrapper.querySelector('material-button[raised]');
        console.log('[LOP] Method 1 (.main .wrapper material-button[raised]):', applyButton ? 'Found ✅' : 'Not found');
      }
    }
    
    // Method 2: Direct selector for the specific structure
    if (!applyButton) {
      applyButton = popup.querySelector('.popup .main .wrapper material-button[raised]');
      console.log('[LOP] Method 2 (.popup .main .wrapper):', applyButton ? 'Found ✅' : 'Not found');
    }
    
    // Method 3: Search for ANY material-button with [raised] attribute in visible popup
    if (!applyButton) {
      applyButton = popup.querySelector('material-button[raised]');
      console.log('[LOP] Method 3 (popup material-button[raised]):', applyButton ? 'Found ✅' : 'Not found');
    }
    
    // Method 4: Search GLOBALLY for visible buttons with "Áp dụng" text
    if (!applyButton) {
      const allButtons = document.querySelectorAll('material-button, button');
      console.log('[LOP] Method 4: Found', allButtons.length, 'total buttons, searching for "Áp dụng"...');
      
      applyButton = Array.from(allButtons).find(btn => {
        const text = btn.textContent.trim();
        const isVisible = btn.offsetParent !== null;
        if ((text === 'Áp dụng' || text.includes('Áp dụng')) && isVisible) {
          console.log('[LOP] Found button with "Áp dụng" text ✅:', {
            text,
            class: btn.className,
            parent: btn.parentElement?.className
          });
          return true;
        }
        return false;
      });
    }
    
    // Method 5: Search in .wrapper anywhere in document (global fallback)
    if (!applyButton) {
      const wrappers = document.querySelectorAll('.wrapper');
      console.log('[LOP] Method 5: Found', wrappers.length, '.wrapper elements');
      for (const wrapper of wrappers) {
        const btn = wrapper.querySelector('material-button[raised]');
        if (btn && btn.offsetParent !== null && btn.textContent.trim().includes('Áp dụng')) {
          applyButton = btn;
          console.log('[LOP] Found in .wrapper ✅');
          break;
        }
      }
    }
    
    if (!applyButton) {
      // Final debug: Log all visible material-buttons
      console.error('[LOP] ❌ Could not find apply button after 5 methods!');
      const allMaterialButtons = document.querySelectorAll('material-button');
      console.log('[LOP] Logging all', allMaterialButtons.length, 'material-buttons:');
      Array.from(allMaterialButtons).forEach((btn, idx) => {
        if (btn.offsetParent !== null) {
          console.log(`[LOP] Button ${idx}:`, {
            text: btn.textContent.trim().substring(0, 30),
            class: btn.className,
            raised: btn.hasAttribute('raised'),
            parent: btn.parentElement?.className,
            grandparent: btn.parentElement?.parentElement?.className
          });
        }
      });
      throw new Error('Apply button not found after trying all methods');
    }
    
    console.log('[LOP] ✅ Found "Áp dụng" button successfully!');
    console.log('[LOP] Button details:', {
      text: applyButton.textContent.trim(),
      class: applyButton.className,
      tag: applyButton.tagName,
      parent: applyButton.parentElement?.className
    });
    
    // Click with multiple methods for maximum compatibility
    console.log('[LOP] 🖱️ Clicking button...');
    
    // Method 1: Native click
    applyButton.click();
    await delay(100);
    
    // Method 2: Dispatch mouse events (simulates real user click)
    applyButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await delay(50);
    applyButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    await delay(50);
    applyButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    
    // Wait for changes to apply
    await delay(1500);
    console.log('[LOP] ✅ Button clicked successfully');
    
    console.log('[LOP] ✅ Lop selection completed successfully');
    return true;
    
  } catch (error) {
    console.error('[LOP] ❌ Error:', error.message);
    throw error;
  }
}

// ---- Download Google Sheet Function ----
async function downloadGoogleSheetFunction(fileName = 'Report') {
  // Helper functions - must be self-contained
  const delay = ms => new Promise(r => setTimeout(r, ms));
  
  async function waitForSelector(selector, timeout = 10000) { // Increased from 5000
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await delay(300); // Increased from 200
    }
    return null;
  }
  
  // MutationObserver-based wait for element (handles dynamic content)
  async function waitForElement(selector, timeout = 15000) { // Increased from 8000
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
  async function retry(fn, retries = 3, delayMs = 2000) { // Increased from 1000
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
      await delay(1200); // Increased from 800 for slow networks
      console.log('[DOWNLOAD] ✅ Download menu opened');
    }, 3, 2000); // Increased from 1000
    
    // Step 2: Wait for menu popup and click "Google Trang tính" option
    await retry(async () => {
      // Wait for the menu to appear - increased timeout
      const googleSheetOption = await waitForElement('material-select-item[aria-label="Google Trang tính"]', 10000); // Increased from 5000
      if (!googleSheetOption) throw new Error('Google Sheets option not found in menu');
      
      console.log('[DOWNLOAD] 📊 Clicking "Google Trang tính" option...');
      googleSheetOption.click();
      await delay(1500); // Increased from 1000 for dialog to appear
      console.log('[DOWNLOAD] ✅ Google Sheets option selected');
    }, 3, 2000); // Increased from 1000
    
    // Step 3: Wait for dialog and fill in file name
    await retry(async () => {
      // Wait for the dialog to appear - increased timeout
      const dialog = await waitForElement('material-dialog.basic-dialog', 10000); // Increased from 5000
      if (!dialog) throw new Error('Download dialog not found');
      
      console.log('[DOWNLOAD] 📝 Dialog appeared, looking for file name input...');
      
      // Find the file name input field
      const fileNameInput = dialog.querySelector('material-input input[type="text"]') ||
                           dialog.querySelector('material-input.themeable input');
      
      if (!fileNameInput) throw new Error('File name input not found in dialog');
      
      console.log(`[DOWNLOAD] ✏️ Filling file name: "${fileName}"...`);
      
      // Clear existing value and set new file name
      fileNameInput.focus();
      await delay(300); // Increased from 200
      fileNameInput.value = '';
      await delay(150); // Increased from 100
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
    
    // Save to storage with mutex lock to prevent race condition
    safeStorageWrite(async () => {
      const data = await chrome.storage.local.get('tabSettings');
      const tabSettings = data.tabSettings || {};
      if (!tabSettings[tabId]) tabSettings[tabId] = {};
      tabSettings[tabId].captureRegion = region;
      tabSettings[tabId].dpr = dpr;
      await chrome.storage.local.set({ tabSettings });
      console.log(`[STORAGE] ✅ Saved region for tab ${tabId}`);
    });
    
    sendResponse({ status: 'saved' });
    return true;
  }
  
  if (req.action === 'clearCaptureRegion') {
    const { tabId } = req;
    console.log(`[MESSAGE] Clearing capture region for tab ${tabId}`);
    
    CAPTURE_REGIONS.delete(tabId);
    
    // Clear from storage with mutex lock
    safeStorageWrite(async () => {
      const data = await chrome.storage.local.get('tabSettings');
      const tabSettings = data.tabSettings || {};
      if (tabSettings[tabId]) {
        delete tabSettings[tabId].captureRegion;
        delete tabSettings[tabId].dpr;
        await chrome.storage.local.set({ tabSettings });
        console.log(`[STORAGE] ✅ Cleared region for tab ${tabId}`);
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
