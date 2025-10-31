(function() {
  // Ngăn việc tiêm nhiều lần
  if (document.getElementById('__my_screenshot_overlay__')) {
    return;
  }

  // 1. Tạo các element
  const overlay = document.createElement('div');
  overlay.id = '__my_screenshot_overlay__';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    background: 'rgba(0, 0, 0, 0.5)',
    zIndex: 99999998,
    cursor: 'crosshair'
  });

  const selectionBox = document.createElement('div');
  selectionBox.id = '__my_screenshot_selection__';
  Object.assign(selectionBox.style, {
    position: 'absolute',
    border: '2px dashed #fff',
    background: 'rgba(255, 255, 255, 0.2)',
    zIndex: 99999999,
    display: 'none'
  });

  document.body.appendChild(overlay);
  overlay.appendChild(selectionBox);

  let startX = 0;
  let startY = 0;
  let isDragging = false;
  let rect = {};

  // 2. Xử lý sự kiện Mouse
  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault(); 
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    rect = { x: startX, y: startY, width: 0, height: 0 }; 
    selectionBox.style.display = 'block';
    selectionBox.style.left = startX + 'px';
    selectionBox.style.top = startY + 'px';
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    rect.x = Math.min(startX, currentX);
    rect.y = Math.min(startY, currentY);
    rect.width = Math.abs(startX - currentX);
    rect.height = Math.abs(startY - currentY);
    selectionBox.style.left = rect.x + 'px';
    selectionBox.style.top = rect.y + 'px';
    selectionBox.style.width = rect.width + 'px';
    selectionBox.style.height = rect.height + 'px';
  });

  overlay.addEventListener('mouseup', (e) => {
    isDragging = false;
    
    // Lấy tọa độ (CSS pixels)
    const captureRegion = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
    
    // Lấy DPR (Device Pixel Ratio)
    const dpr = window.devicePixelRatio || 1;

    // Chỉ lưu nếu người dùng thực sự KÉO
    if (captureRegion.width > 0 && captureRegion.height > 0) {
      
      // *** THAY ĐỔI QUAN TRỌNG: Gửi thông điệp tới background script ***
      chrome.runtime.sendMessage({
        action: "saveCaptureRegion",
        region: captureRegion,
        dpr: dpr
      });

    }

    // 4. Dọn dẹp
    document.body.removeChild(overlay);
  });

  // Hủy bằng phím Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      document.body.removeChild(overlay);
    }
  }, { once: true }); 

})();