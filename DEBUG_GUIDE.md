# 🔍 Hướng dẫn Debug Extension

## Bước 1: Reload Extension

1. Mở Chrome và truy cập `chrome://extensions/`
2. Tìm extension "Công cụ Chụp ảnh & Xuất Excel"
3. Click vào biểu tượng **🔄 Reload** (hoặc tắt rồi bật lại)
4. ✅ Extension đã được reload với code mới

## Bước 2: Mở DevTools Console

### Để xem log từ Background Script:
1. Vào `chrome://extensions/`
2. Tìm extension của bạn
3. Click vào **"service worker"** (màu xanh)
4. Một cửa sổ DevTools sẽ mở ra
5. ✅ Bạn sẽ thấy tất cả log từ `background.js` tại đây

### Để xem log từ Popup:
1. Click chuột phải vào icon extension
2. Chọn **"Inspect popup"**
3. DevTools sẽ mở ra
4. ✅ Bạn sẽ thấy tất cả log từ `popup.js` tại đây

### Để xem log từ Content Script:
1. Mở trang web bạn muốn test
2. Nhấn **F12** để mở DevTools
3. Chọn tab **Console**
4. ✅ Bạn sẽ thấy log từ `content_selector.js` tại đây

## Bước 3: Test từng bước

### Test 1: Kiểm tra lưu thông tin
1. Mở popup extension
2. Nhập Bot Token và Chat ID
3. Click **💾 Lưu**
4. Mở Console của popup (Inspect popup)
5. Chạy lệnh:
```javascript
chrome.storage.local.get(['globalSettings', 'tabSettings'], (data) => {
  console.log('Settings:', data);
});
```
6. ✅ Kiểm tra xem `botToken` và `chatId` có được lưu không

### Test 2: Kiểm tra khi bấm "Bắt đầu Auto"
1. Mở Console của popup
2. Mở Console của background (service worker)
3. Click **🚀 Bắt đầu Auto**
4. **Trong popup console**, bạn sẽ thấy:
   ```
   [POPUP] Send button clicked
   [POPUP] Action: startAutoSend, Tab: 123, Interval: 10min
   [POPUP] Sending message to background: startAutoSend
   [POPUP] Response from background: {status: 'started'}
   ```
5. **Trong background console**, bạn sẽ thấy:
   ```
   [AUTO] Starting auto send for tab 123, interval: 10 minutes
   [AUTO] ====== Starting job for tab 123 ======
   [AUTO] Config - botToken: ✓ exists, chatId: 123456, timeout: 3000ms
   [AUTO] 📄 Reloading tab 123...
   [AUTO] ⏳ Waiting 3000ms for page to load...
   [AUTO] 📊 Scraping table data from tab 123...
   [AUTO] 📊 Scraped X rows
   [AUTO] 📸 Capturing screenshot...
   [AUTO] 📤 Sending to Telegram...
   [AUTO] ✅ Job completed successfully for tab 123
   ```

### Test 3: Kiểm tra lỗi thường gặp

#### Lỗi: "Không có gì xảy ra"
**Nguyên nhân:** Chưa lưu Bot Token hoặc Chat ID

**Giải pháp:**
1. Mở console popup
2. Kiểm tra có thông báo: `[POPUP] Missing chatId or invalid interval`
3. Nhấn **💾 Lưu** trước khi bấm **Bắt đầu Auto**

#### Lỗi: "Gửi Telegram thất bại"
**Nguyên nhân:** Bot Token hoặc Chat ID sai

**Giải pháp:**
1. Mở console background
2. Tìm log: `[TELEGRAM] Attempt 1/3 failed: ...`
3. Đọc message lỗi từ Telegram API
4. Kiểm tra lại Bot Token và Chat ID

#### Lỗi: "Không scrape được dữ liệu"
**Nguyên nhân:** Trang không có bảng hoặc trang chưa load xong

**Giải pháp:**
1. Mở console background
2. Tìm log: `[AUTO] 📊 Scraped 0 rows`
3. Tăng `pageLoadTimeout` lên (ví dụ: 5000ms)
4. Kiểm tra trang có bảng `<table>` không

#### Lỗi: Badge hiển thị ✗
**Nguyên nhân:** Có lỗi trong quá trình chạy job

**Giải pháp:**
1. Mở console background
2. Tìm log: `[AUTO] ❌ Error in job for tab ...`
3. Đọc chi tiết lỗi và stack trace

## Bước 4: Test thủ công từng chức năng

### Test Capture Screenshot:
```javascript
// Chạy trong background console
chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
  const img = await captureTab(tabs[0].id);
  console.log('Image size:', img.length);
});
```

### Test Scraping:
```javascript
// Chạy trong tab console (F12)
const data = scrapeDynamicTableData(); // Hàm này cần copy vào
console.table(data);
```

### Test Gửi Telegram:
```javascript
// Chạy trong background console (thay YOUR_BOT_TOKEN và YOUR_CHAT_ID)
const botToken = 'YOUR_BOT_TOKEN';
const chatId = 'YOUR_CHAT_ID';
const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

sendToTelegram(botToken, chatId, testImage, null)
  .then(() => console.log('✅ Sent!'))
  .catch(err => console.error('❌ Error:', err));
```

## Các Log quan trọng cần chú ý:

### ✅ Log thành công:
- `[POPUP] Response from background: {status: 'started'}`
- `[AUTO] ✅ Job completed successfully`
- `[TELEGRAM] ✅ Sent successfully`

### ⚠️ Log cảnh báo:
- `[AUTO] ⚠️ Missing credentials`
- `[AUTO] ⚠️ No table data found`

### ❌ Log lỗi:
- `[POPUP] Runtime error:`
- `[AUTO] ❌ Error in job for tab`
- `[TELEGRAM] Attempt X/3 failed:`

## Tips:

1. **Luôn reload extension** sau khi sửa code
2. **Mở console trước** khi test để không bỏ lỡ log
3. **Kiểm tra network tab** để xem request gửi Telegram
4. **Dùng chrome.storage viewer** để xem dữ liệu lưu trữ
5. **Test từng bước** thay vì test cả flow

## Kiểm tra nhanh:

```javascript
// Chạy trong background console để kiểm tra trạng thái
console.log('Active intervals:', JOB_INTERVALS);
console.log('Capture regions:', CAPTURE_REGIONS);

// Chạy trong popup console để kiểm tra settings
chrome.storage.local.get(null, (data) => {
  console.log('All settings:', data);
});
```

---

**Lưu ý:** Nếu vẫn không hoạt động sau khi làm theo hướng dẫn, hãy copy toàn bộ log từ console và báo lỗi chi tiết!
