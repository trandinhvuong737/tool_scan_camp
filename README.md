# 🚀 Auto Tool Khang - Chrome Extension V2.0

Extension Chrome tự động chụp ảnh và xuất dữ liệu bảng sang Excel, gửi qua Telegram theo lịch định kỳ.

## 🆕 Version 2.0 - Major Upgrade

**Viết lại hoàn toàn với Manifest V3 Best Practices:**
- ⚡ Task Queue để chống race condition
- 📸 TabCapture API với fallback thông minh (không cần focus tab)
- ⏰ Chrome Alarms API thay vì setInterval (persistent)
- 🔁 Retry logic với Telegram notification
- 🖼️ OffscreenCanvas crop trong service worker
- 📊 Inline scraping function (all-in-one injection)

👉 **[Xem chi tiết cải tiến](./IMPROVEMENTS_V2.md)**

## ✨ Tính năng chính

### 📸 Chụp ảnh thông minh
- ✂️ **Chọn vùng chụp**: Chọn chính xác vùng cần chụp trên trang web
- 🗑️ **Xóa vùng đã chọn**: Quay lại chế độ chụp toàn màn hình
- 📊 **Hiển thị vùng đã chọn**: Xem kích thước vùng đã chọn ngay trên popup

### 📊 Xuất Excel tự động
- 🎯 **Scraping thông minh**: Tự động nhận diện bảng với class `.particle-table-header` và attribute `essfield`
- 📋 **Fallback**: Nếu không tìm thấy bảng đặc biệt, tự động lấy bảng đầu tiên
- 📝 **Header detection**: Tự động nhận diện header từ `<thead>` hoặc class đặc biệt

### 🤖 Auto gửi Telegram
- ⏰ **Định kỳ tự động**: Đặt thời gian gửi (phút)
- 🔄 **Reload tự động**: Tự động reload trang trước khi scrape để có dữ liệu mới nhất
- ⚡ **Gửi song song**: Gửi ảnh và Excel cùng lúc để tối ưu tốc độ
- 🔁 **Retry mechanism**: Tự động thử lại 3 lần nếu gửi thất bại
- 📊 **Badge notification**: Hiển thị ✓ (thành công) hoặc ✗ (lỗi) trên icon extension

### 🎨 Giao diện thân thiện
- ⏱️ **Countdown timer**: Hiển thị thời gian đến lần gửi tiếp theo
- 🎯 **Status messages**: Thông báo rõ ràng cho mọi hành động
- 🔧 **Cấu hình linh hoạt**: 
  - Bot Token (dùng chung cho tất cả tab)
  - Chat ID (riêng cho từng tab)
  - Thời gian gửi (phút)
  - Timeout tải trang (ms)

## 📦 Cài đặt

1. Clone repository này
2. Mở Chrome và truy cập `chrome://extensions/`
3. Bật "Developer mode" ở góc trên bên phải
4. Click "Load unpacked" và chọn thư mục chứa extension
5. Extension sẵn sàng sử dụng!

## 🔧 Cách sử dụng

### Bước 1: Cấu hình Telegram Bot
1. Tạo bot với [@BotFather](https://t.me/BotFather) trên Telegram
2. Lấy **Bot Token** (dạng: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
3. Lấy **Chat ID** của bạn (có thể dùng [@userinfobot](https://t.me/userinfobot))

### Bước 2: Cấu hình Extension
1. Click vào icon extension
2. Nhập **Bot Token** (dùng chung cho tất cả tab)
3. Nhập **Chat ID** (riêng cho tab này)
4. Đặt thời gian gửi (mặc định: 10 phút)
5. Đặt timeout tải trang (mặc định: 3000ms)
6. Click **💾 Lưu**

### Bước 3: Chọn vùng chụp (Tùy chọn)
1. Click **✂️ Chọn Vùng Chụp**
2. Kéo chuột để chọn vùng cần chụp
3. Vùng đã chọn sẽ được hiển thị trong popup
4. Click **🗑️ Xóa vùng đã chọn** để quay lại chụp toàn màn hình

### Bước 4: Bắt đầu Auto
1. Click **🚀 Bắt đầu Auto**
2. Extension sẽ:
   - Reload trang sau mỗi khoảng thời gian đã đặt
   - Chụp ảnh (toàn bộ hoặc vùng đã chọn)
   - Scrape dữ liệu bảng và tạo file Excel
   - Gửi ảnh + Excel qua Telegram
3. Theo dõi countdown để biết thời gian gửi tiếp theo
4. Click **🔴 Dừng Auto** để dừng

## 🏗️ Kiến trúc

### Files chính:
- `manifest.json` - Cấu hình extension
- `popup.html` / `popup.js` - Giao diện popup
- `background.js` - Service worker xử lý auto send, scraping, capture
- `content_selector.js` - Script chọn vùng chụp
- `offscreen.html` / `offscreen.js` - Capture tab không cần focus (dự phòng)

### Flow hoạt động:

```
User chọn vùng → content_selector.js 
    ↓
    Gửi tọa độ vùng → background.js (lưu vào storage)
    ↓
User bật Auto → popup.js gửi message → background.js
    ↓
background.js tạo interval:
    ├─ Reload tab
    ├─ Sleep (pageLoadTimeout)
    ├─ Execute scrapeDynamicTableData() trong tab
    ├─ Capture tab (crop nếu có vùng chọn)
    ├─ Tạo Excel từ dữ liệu scrape
    ├─ Gửi ảnh + Excel qua Telegram (retry 3 lần)
    └─ Hiển thị badge ✓ hoặc ✗
```

## 🔥 Cải tiến so với phiên bản cũ

### ✅ Đã sửa:
1. **Bug chọn vùng**: Thêm handler trong background.js để nhận và lưu vùng chụp
2. **Thiếu crop logic**: Implement hàm `cropImage()` sử dụng OffscreenCanvas
3. **Scraping đơn giản**: Nâng cấp thành `scrapeDynamicTableData()` với khả năng nhận diện bảng phức tạp
4. **Không có retry**: Thêm retry mechanism với exponential backoff
5. **Hard-coded timeout**: Cho phép cấu hình `pageLoadTimeout`

### 🆕 Tính năng mới:
1. **Preview vùng đã chọn**: Hiển thị kích thước vùng ngay trong popup
2. **Nút xóa vùng**: Dễ dàng reset về chế độ chụp toàn màn hình
3. **Countdown timer**: Biết chính xác thời gian đến lần gửi tiếp theo
4. **Badge notification**: Hiển thị trạng thái thành công/lỗi trên icon
5. **Error handling tốt hơn**: Thông báo lỗi chi tiết, retry tự động
6. **Console logging**: Dễ dàng debug qua DevTools

## 🛠️ Troubleshooting

### Không gửi được Telegram?
- Kiểm tra Bot Token có đúng không
- Kiểm tra Chat ID có đúng không
- Mở Console (F12) xem log lỗi chi tiết

### Scraping không đúng dữ liệu?
- Mở Console và xem log `[AUTO]`
- Kiểm tra cấu trúc HTML của bảng
- Tăng `pageLoadTimeout` nếu trang load chậm

### Ảnh bị cắt sai?
- Xóa vùng đã chọn và chọn lại
- Kiểm tra device pixel ratio (DPR) của màn hình

## 📄 License

MIT License - Free to use and modify

## 👨‍💻 Developer

Created with ❤️ by Khang
