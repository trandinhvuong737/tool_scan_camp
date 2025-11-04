// --- HÀM GỬI THÔNG BÁO TRẠNG THÁI ---
function showStatus(message, isError = false) {
    let statusElement = document.getElementById('statusMessage');
    if (!statusElement) {
        const newStatus = document.createElement('div');
        newStatus.id = 'statusMessage';
        newStatus.style.marginTop = '10px';
        newStatus.style.fontSize = '12px';
        newStatus.style.fontWeight = 'bold';
        // Find a good place to insert the status message, e.g., after the last button
        const lastButton = document.querySelector('button:last-of-type');
        if (lastButton) {
            lastButton.insertAdjacentElement('afterend', newStatus);
        } else {
            document.body.appendChild(newStatus);
        }
        statusElement = newStatus;
    }
    statusElement.textContent = message;
    statusElement.style.color = isError ? 'red' : 'green';
    setTimeout(() => {
        if (statusElement) {
            statusElement.textContent = '';
        }
    }, 5000); // Xóa thông báo sau 5 giây
}

// --- HÀM HIỂN THỊ REGION INFO ---
function updateRegionDisplay(region) {
    const regionInfo = document.getElementById('regionInfo');
    const regionText = document.getElementById('regionText');
    const clearBtn = document.getElementById('clearAreaBtn');
    
    if (region && region.width > 0 && region.height > 0) {
        regionText.textContent = `${region.width} x ${region.height} px`;
        regionInfo.style.display = 'block';
        clearBtn.style.display = 'block';
    } else {
        regionInfo.style.display = 'none';
        clearBtn.style.display = 'none';
    }
}

// --- HÀM COUNTDOWN ---
let countdownInterval = null;
function startCountdown(intervalMinutes) {
    const countdownDiv = document.getElementById('countdown');
    let secondsLeft = intervalMinutes * 60;
    
    const updateDisplay = () => {
        const minutes = Math.floor(secondsLeft / 60);
        const seconds = secondsLeft % 60;
        countdownDiv.textContent = `⏱️ Gửi tiếp trong: ${minutes}:${seconds.toString().padStart(2, '0')}`;
        secondsLeft--;
        
        if (secondsLeft < 0) {
            secondsLeft = intervalMinutes * 60; // Reset
        }
    };
    
    countdownDiv.style.display = 'block';
    updateDisplay();
    countdownInterval = setInterval(updateDisplay, 1000);
}

function stopCountdown() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    const countdownDiv = document.getElementById('countdown');
    countdownDiv.style.display = 'none';
}


// --- LOGIC XỬ LÝ SỰ KIỆN ---

document.addEventListener('DOMContentLoaded', async () => {
  let activeTabId = null;
  const sendBtn = document.getElementById('sendTelegramBtn');
  const intervalInput = document.getElementById('interval');
  const pageLoadTimeoutInput = document.getElementById('pageLoadTimeout');
  const startDateInput = document.getElementById('startDate');
  const endDateInput = document.getElementById('endDate');
  const fileNameInput = document.getElementById('fileName');

  // Lấy tab hiện tại để biết ID
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0) {
    activeTabId = tabs[0].id;
  }

  // Hàm cập nhật giao diện nút bấm
  const updateButtonUI = (isAutoRunning) => {
      if (isAutoRunning) {
          sendBtn.textContent = '🔴 Dừng Auto';
          sendBtn.classList.add('running');
          intervalInput.disabled = true;
          pageLoadTimeoutInput.disabled = true;
      } else {
          sendBtn.textContent = '🚀 Bắt đầu Auto';
          sendBtn.classList.remove('running');
          intervalInput.disabled = false;
          pageLoadTimeoutInput.disabled = false;
      }
  };

  // Tải cài đặt và cập nhật UI
  if (activeTabId) {
      chrome.storage.local.get(['globalSettings', 'tabSettings'], (data) => {
          const globalSettings = data.globalSettings || {};
          const tabSettings = data.tabSettings || {};
          const tabSpecificSettings = tabSettings[activeTabId] || {};

          if (globalSettings.botToken) {
              document.getElementById('botToken').value = globalSettings.botToken;
          }
          if (tabSpecificSettings.chatId) {
              document.getElementById('chatId').value = tabSpecificSettings.chatId;
          }
          if (tabSpecificSettings.interval) {
              intervalInput.value = tabSpecificSettings.interval;
          }
          if (tabSpecificSettings.pageLoadTimeout) {
              pageLoadTimeoutInput.value = tabSpecificSettings.pageLoadTimeout;
          }
          if (tabSpecificSettings.startDate) {
              startDateInput.value = tabSpecificSettings.startDate;
          }
          if (tabSpecificSettings.endDate) {
              endDateInput.value = tabSpecificSettings.endDate;
          }
          if (tabSpecificSettings.fileName) {
              fileNameInput.value = tabSpecificSettings.fileName;
          }
          
          // Hiển thị region nếu có
          updateRegionDisplay(tabSpecificSettings.captureRegion);
          
          const isRunning = tabSpecificSettings.isAutoRunning || false;
          updateButtonUI(isRunning);
          
          // Bắt đầu countdown nếu đang chạy
          if (isRunning) {
              startCountdown(tabSpecificSettings.interval || 10);
          }
      });
  }


  // Xử lý nút Lưu
  document.getElementById('saveTelegramBtn').addEventListener('click', () => {
    const botToken = document.getElementById('botToken').value;
    const chatId = document.getElementById('chatId').value;
    const interval = parseInt(intervalInput.value, 10);
    const pageLoadTimeout = parseInt(pageLoadTimeoutInput.value, 10);
    const startDate = startDateInput.value;
    const endDate = endDateInput.value;
    const fileName = fileNameInput.value.trim();

    if (!botToken) {
      showStatus('Vui lòng nhập Bot Token.', true);
      return;
    }
    if (!activeTabId) {
        showStatus('Không thể xác định tab hiện tại.', true);
        return;
    }

    chrome.storage.local.get(['globalSettings', 'tabSettings'], (data) => {
        let globalSettings = data.globalSettings || {};
        let tabSettings = data.tabSettings || {};

        globalSettings.botToken = botToken;

        if (!tabSettings[activeTabId]) {
            tabSettings[activeTabId] = {};
        }
        tabSettings[activeTabId].chatId = chatId;
        tabSettings[activeTabId].interval = interval;
        tabSettings[activeTabId].pageLoadTimeout = pageLoadTimeout;
        tabSettings[activeTabId].startDate = startDate;
        tabSettings[activeTabId].endDate = endDate;
        tabSettings[activeTabId].fileName = fileName;

        chrome.storage.local.set({ globalSettings, tabSettings }, () => {
          showStatus('Đã lưu thông tin!');
        });
    });
  });

  // 1. XỬ LÝ NÚT CHỌN VÙNG
  document.getElementById('selectAreaBtn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          files: ['content_selector.js']
        });
        window.close();
      }
    });
  });

  // 1b. XỬ LÝ NÚT XÓA VÙNG
  document.getElementById('clearAreaBtn').addEventListener('click', () => {
    if (!activeTabId) return;
    
    chrome.runtime.sendMessage({
      action: 'clearCaptureRegion',
      tabId: activeTabId
    }, (response) => {
      if (response && response.status === 'cleared') {
        updateRegionDisplay(null);
        showStatus('Đã xóa vùng chụp!');
      }
    });
  });

  // 2. XỬ LÝ NÚT BẮT ĐẦU/DỪNG AUTO
  sendBtn.addEventListener('click', () => {
    console.log('[POPUP] Send button clicked');
    
    if (!activeTabId) {
        console.error('[POPUP] No active tab ID');
        showStatus('Lỗi: Không thể xác định tab hiện tại.', true);
        return;
    }

    chrome.storage.local.get('tabSettings', (data) => {
        const tabSettings = data.tabSettings || {};
        const isCurrentlyRunning = tabSettings[activeTabId]?.isAutoRunning || false;
        const action = isCurrentlyRunning ? "stopAutoSend" : "startAutoSend";
        const interval = parseInt(intervalInput.value, 10);
        const pageLoadTimeout = parseInt(pageLoadTimeoutInput.value, 10);

        console.log(`[POPUP] Action: ${action}, Tab: ${activeTabId}, Interval: ${interval}min, Timeout: ${pageLoadTimeout}ms`);
        console.log(`[POPUP] Current settings:`, tabSettings[activeTabId]);

        if (action === "startAutoSend" && (!tabSettings[activeTabId]?.chatId || interval < 1)) {
            console.warn('[POPUP] Missing chatId or invalid interval');
            showStatus('Vui lòng lưu Chat ID và đặt thời gian > 0.', true);
            return;
        }

        // Cập nhật trạng thái ngay lập tức trên UI
        const newRunningState = !isCurrentlyRunning;
        updateButtonUI(newRunningState);
        if (!tabSettings[activeTabId]) tabSettings[activeTabId] = {};
        tabSettings[activeTabId].isAutoRunning = newRunningState;
        tabSettings[activeTabId].interval = interval;
        tabSettings[activeTabId].pageLoadTimeout = pageLoadTimeout;
        chrome.storage.local.set({ tabSettings });

        console.log(`[POPUP] Sending message to background: ${action}`);
        
        // Gửi lệnh tới background script
        chrome.runtime.sendMessage({
            action: action,
            tabId: activeTabId,
            interval: interval
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('[POPUP] Runtime error:', chrome.runtime.lastError);
                showStatus(`Lỗi: ${chrome.runtime.lastError.message}`, true);
                // Rollback UI
                updateButtonUI(isCurrentlyRunning);
                tabSettings[activeTabId].isAutoRunning = isCurrentlyRunning;
                chrome.storage.local.set({ tabSettings });
            } else {
                console.log('[POPUP] Response from background:', response);
                if (response.status === 'started') {
                    showStatus('Đã bắt đầu auto!');
                    startCountdown(interval);
                } else {
                    showStatus('Đã dừng auto.');
                    stopCountdown();
                }
            }
        });
    });
  });

});