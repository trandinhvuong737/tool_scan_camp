// content_helper.js - Luôn được inject vào mọi tab để đảm bảo communication

console.log('[CONTENT] Helper script loaded');

// Helper để content script có thể giao tiếp với background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ status: 'ready' });
    return true;
  }
  
  // Có thể thêm các message handlers khác nếu cần
  return false;
});

// Export helper để inject function có thể dùng
window.__extensionHelpers = {
  delay: (ms) => new Promise(r => setTimeout(r, ms)),
  
  waitForSelector: async (selector, timeout = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await window.__extensionHelpers.delay(200);
    }
    return null;
  },
  
  waitForElement: async (selector, timeout = 8000) => {
    // Dùng MutationObserver để đợi element xuất hiện
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
};

console.log('[CONTENT] Helper ready, __extensionHelpers available');
