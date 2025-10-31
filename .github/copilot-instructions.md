# Project Overview & Architecture

This is a Chrome browser extension designed to capture screenshots and extract tabular data from web pages, exporting it to an Excel file.

The core architecture consists of:
- A popup interface (`popup.html` and `popup.js`) that serves as the main user control panel.
- A content script (`content_selector.js`) injected into the active tab to allow users to select a specific area of the page for screenshots.
- A dynamically-injected function (`scrapeDynamicTableData` from `popup.js`) that scrapes structured data from the page.
- The `xlsx.full.min.js` library is used to generate Excel files from the scraped data.

## Key Files

- `manifest.json`: Defines the extension's permissions, UI, and scripts.
- `popup.js`: Contains the primary logic for the extension's popup. It handles button clicks for capturing screenshots and initiating the Excel export. It also contains the `scrapeDynamicTableData` function that is injected into the webpage.
- `content_selector.js`: This script is responsible for the "select area" feature. It creates an overlay on the current page, allowing the user to draw a rectangle. The coordinates of this selection are saved to `chrome.storage.local`.
- `xlsx.full.min.js`: The SheetJS library for creating `.xlsx` files.

## Developer Workflows

### 1. Data Scraping Workflow

The primary data scraping logic is within the `scrapeDynamicTableData` function in `popup.js`. This function is highly specific to the HTML structure of the target website's tables (e.g., classes like `.particle-table-header`, attributes like `essfield`).

- **To modify the scraping logic**: You must edit the `scrapeDynamicTableData` function inside `popup.js`.
- The function is executed in the context of the active tab via `chrome.scripting.executeScript`.
- The scraped data (an array of arrays) is returned to the `executeScript` callback in `popup.js`.
- The `XLSX.utils.aoa_to_sheet` function then converts this array into a worksheet, which is downloaded.

### 2. Screenshot Workflow

There are two screenshot modes: full page and regional.

- **Regional Screenshot**:
    1. The user clicks the "Select Area" button (`selectAreaBtn`).
    2. `content_selector.js` is injected into the page.
    3. The user draws a rectangle. On `mouseup`, the script saves the region's coordinates and the device pixel ratio (`dpr`) to `chrome.storage.local`.
    4. The user clicks the "Take Screenshot" button (`screenshotBtn`).
    5. `popup.js` reads the `captureRegion` and `dpr` from storage.
    6. It captures the visible tab, then uses the `clipImage` helper function to crop the image to the selected coordinates before downloading it.

- **Full Screenshot**: If no `captureRegion` is found in storage, clicking the "Take Screenshot" button captures the entire visible tab and downloads it without clipping.

## Conventions & Patterns

- **Data Passing**: The extension uses `chrome.storage.local` to pass data from the content script (`content_selector.js`) to the popup script (`popup.js`). This is how the selected screenshot region is communicated.
- **Dynamic Script Injection**: Logic is injected into the active tab using `chrome.scripting.executeScript`. This is used for both injecting the `content_selector.js` file and executing the `scrapeDynamicTableData` function.
- **External Libraries**: The `xlsx.full.min.js` library is included directly in the project for Excel generation.
