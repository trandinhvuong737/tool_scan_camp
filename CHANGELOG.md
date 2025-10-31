# 📝 Changelog

## [Version 2.0] - 2025-10-31

### 🎉 Major Improvements

#### 🐛 Bug Fixes
1. **Fixed Region Selection Flow**
   - ✅ Added message handler in `background.js` to receive and save capture region from `content_selector.js`
   - ✅ Implemented `cropImage()` function using OffscreenCanvas API
   - ✅ Region selection now actually works and crops the screenshot correctly

2. **Fixed Scraping Logic**
   - ✅ Replaced simple table scraping with advanced `scrapeDynamicTableData()`
   - ✅ Now detects tables with `.particle-table-header` class
   - ✅ Supports `essfield` attributes for special data extraction
   - ✅ Fallback to first table if no special table found

3. **Fixed Error Handling**
   - ✅ Added try-catch blocks throughout the code
   - ✅ Implemented retry mechanism (3 attempts with exponential backoff)
   - ✅ Proper error messages from Telegram API

#### ✨ New Features

1. **Region Preview & Management**
   - 📊 Display selected region size in popup (e.g., "1024 x 768 px")
   - 🗑️ "Clear Region" button to reset to full screenshot mode
   - 💾 Region info persisted in storage per tab

2. **Countdown Timer**
   - ⏱️ Real-time countdown showing time until next send
   - 🔄 Updates every second
   - 📱 Visible in popup while auto is running

3. **Visual Feedback**
   - ✅ Badge shows "✓" (green) on successful send
   - ❌ Badge shows "✗" (red) on error
   - ⏰ Auto-clears after 3 seconds

4. **Configurable Timeout**
   - ⚙️ Added "Page Load Timeout" setting (default: 3000ms)
   - 🔧 Per-tab configuration saved in storage
   - 🚀 Can adjust for slow-loading pages

5. **Better UX**
   - 🎨 Wider popup (250px instead of 200px)
   - 🎯 Clearer visual hierarchy
   - 🔒 Disabled inputs while auto is running
   - 📝 Status messages for all actions

#### 🔧 Technical Improvements

1. **Storage Management**
   - Global settings: `botToken`
   - Per-tab settings: `chatId`, `interval`, `pageLoadTimeout`, `captureRegion`, `dpr`, `isAutoRunning`
   - Proper cleanup when clearing region

2. **Message Handling**
   - Added `saveCaptureRegion` action
   - Added `clearCaptureRegion` action
   - Fixed `return true` for async message responses

3. **Interval Timing**
   - Changed from seconds to minutes in `runJob()` (multiplied by 60)
   - More accurate countdown timer
   - Proper interval cleanup on stop

4. **Error Messages**
   - Telegram errors now show API description
   - Console logs for debugging
   - User-friendly error messages in popup

#### 📊 Code Quality

- ✅ No errors in ESLint/TypeScript checks
- ✅ Proper async/await usage
- ✅ Clean separation of concerns
- ✅ Comprehensive error handling
- ✅ Well-documented code with comments

---

## [Version 1.0] - Initial Release

### Features
- Basic screenshot capture
- Simple table scraping
- Telegram integration
- Auto-send on interval
- Region selection UI (not functional)
