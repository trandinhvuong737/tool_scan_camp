# 📚 Hàm `runJobForTab` - Vị trí sử dụng và Ý nghĩa

## 🎯 Tổng quan

Hàm `runJobForTab(tabId)` là **hàm core** của extension, thực hiện toàn bộ quy trình:
1. Reload tab
2. Scrape dữ liệu
3. Tạo Excel
4. Capture screenshot
5. Gửi qua Telegram

---

## 📍 2 Vị trí sử dụng `runJobForTab`

### 1️⃣ **Khi User bấm "Bắt đầu Auto"** (Line 490)

```javascript
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'startAutoSend') {
    const { tabId, interval } = req;
    
    // ✅ Chạy JOB NGAY LẬP TỨC
    enqueueTabJob(tabId, () => runJobForTab(tabId));
    
    // Tạo alarm cho các lần sau
    chrome.alarms.create(`autoSend_${tabId}`, {
      delayInMinutes: interval,
      periodInMinutes: interval
    });
    
    sendResponse({ status: 'started' });
  }
});
```

**Ý nghĩa:**
- ✅ **Chạy job ngay lập tức** khi user bấm "Bắt đầu Auto"
- ✅ User không phải đợi 10 phút (interval) mới thấy kết quả đầu tiên
- ✅ Feedback tức thì cho user biết extension hoạt động

**Flow:**
```
User click "Bắt đầu Auto"
    ↓
popup.js gửi message startAutoSend
    ↓
background.js nhận message
    ↓
① Chạy runJobForTab() NGAY (lần đầu)
    ↓
② Tạo alarm để chạy định kỳ (lần 2, 3, 4...)
```

---

### 2️⃣ **Khi Alarm trigger định kỳ** (Line 577)

```javascript
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log('[ALARM] Triggered:', alarm.name);
  
  if (!alarm.name.startsWith('autoSend_')) return;
  
  const tabId = parseInt(alarm.name.split('_')[1]);
  
  // ✅ Chạy JOB ĐỊNH KỲ
  enqueueTabJob(tabId, () => runJobForTab(tabId));
});
```

**Ý nghĩa:**
- ✅ **Chạy job tự động** theo lịch đã đặt (mỗi X phút)
- ✅ Persistent - alarm vẫn hoạt động ngay cả khi service worker bị terminate
- ✅ Reliable - Chrome đảm bảo alarm sẽ trigger đúng giờ

**Flow:**
```
User đặt interval = 10 phút
    ↓
Sau 10 phút, Alarm trigger
    ↓
background.js: onAlarm.addListener
    ↓
Chạy runJobForTab() (lần 2)
    ↓
Sau 10 phút nữa, lại trigger
    ↓
Chạy runJobForTab() (lần 3)
    ↓
... (lặp lại mãi mãi cho đến khi user bấm Dừng)
```

---

## 🔄 Tại sao dùng `enqueueTabJob()` wrapper?

**Không dùng trực tiếp:**
```javascript
runJobForTab(tabId); // ❌ Có thể bị race condition
```

**Dùng qua queue:**
```javascript
enqueueTabJob(tabId, () => runJobForTab(tabId)); // ✅ An toàn
```

**Lý do:**

### Vấn đề: Race Condition
```
Scenario 1: User bấm "Bắt đầu Auto"
    ↓
    Job 1 đang chạy (reload → scrape → capture...)
    
Scenario 2: Vừa lúc đó, alarm trigger
    ↓
    Job 2 cũng bắt đầu chạy
    
KẾT QUẢ:
❌ 2 jobs cùng reload tab → conflict
❌ 2 jobs cùng scrape → lấy data lỗi
❌ 2 jobs cùng capture → ảnh bị duplicate
```

### Giải pháp: Task Queue
```javascript
const tabQueues = new Map(); // tabId → Promise

function enqueueTabJob(tabId, jobFn) {
  const prev = tabQueues.get(tabId) || Promise.resolve();
  const next = prev.then(() => jobFn()).catch(err => {...});
  tabQueues.set(tabId, next);
  return next;
}
```

**Hoạt động:**
```
Job 1 được add vào queue
    ↓ (đang chạy...)
Job 2 đến → đợi Job 1 xong
    ↓
Job 1 xong → Job 2 mới chạy
    ↓ (đang chạy...)
Job 3 đến → đợi Job 2 xong
    ↓
...
```

---

## 📊 So sánh 2 vị trí

| Vị trí | Trigger | Tần suất | Khi nào dùng |
|--------|---------|----------|--------------|
| **startAutoSend** | User bấm button | 1 lần khi start | Chạy ngay lần đầu |
| **Alarm** | Chrome alarm | Định kỳ (interval) | Chạy tự động theo lịch |

---

## 🎯 Timeline thực tế

```
00:00 - User bấm "Bắt đầu Auto" (interval = 10 phút)
        ↓
        ① runJobForTab() chạy NGAY (từ startAutoSend)
        ↓
00:01 - Job hoàn thành, gửi Telegram thành công ✅
        ↓
00:10 - Alarm trigger lần 1
        ↓
        ② runJobForTab() chạy (từ Alarm)
        ↓
00:11 - Job hoàn thành ✅
        ↓
00:20 - Alarm trigger lần 2
        ↓
        ③ runJobForTab() chạy
        ↓
00:21 - Job hoàn thành ✅
        ↓
        ... (tiếp tục mỗi 10 phút)
```

---

## 🔍 Điểm quan trọng

### 1. **Queue đảm bảo tuần tự**
```javascript
enqueueTabJob(tabId, () => runJobForTab(tabId));
```
- ✅ Chỉ 1 job chạy tại 1 thời điểm cho mỗi tab
- ✅ Không bị conflict khi nhiều trigger cùng lúc

### 2. **Alarm persistent**
```javascript
chrome.alarms.create(`autoSend_${tabId}`, {...});
```
- ✅ Alarm tồn tại ngay cả khi service worker terminate
- ✅ Không bị mất như `setInterval`

### 3. **Immediate + Periodic**
- ✅ **startAutoSend**: Chạy ngay + tạo alarm
- ✅ **Alarm**: Chạy định kỳ
- ✅ User không phải đợi interval đầu tiên

---

## 💡 Tóm tắt

**Hàm `runJobForTab`** được gọi ở **2 vị trí**:

1. **startAutoSend (Line 490)**: Chạy NGAY khi user bấm "Bắt đầu Auto"
2. **Alarm Handler (Line 577)**: Chạy ĐỊNH KỲ theo lịch đã đặt

**Tất cả đều qua `enqueueTabJob()`** để:
- ✅ Tránh race condition
- ✅ Đảm bảo jobs chạy tuần tự
- ✅ Code clean và maintainable

**Kết quả:**
- ✅ User có feedback ngay lập tức
- ✅ Auto chạy đúng lịch không sai sót
- ✅ Hệ thống robust, không bị conflict
