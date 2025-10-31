chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'capture-tab') {
    try {
      const stream = await chrome.tabCapture.capture({
        audio: false,
        video: true,
        targetTabId: msg.tabId
      });
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      await new Promise(r => setTimeout(r, 300)); // chờ frame
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      stream.getTracks().forEach(t => t.stop());
      const dataUrl = canvas.toDataURL('image/png');
      chrome.runtime.sendMessage({ type: 'capture-result', id: msg.id, dataUrl });
    } catch (err) {
      chrome.runtime.sendMessage({ type: 'capture-result', id: msg.id, error: err.message });
    }
  }
});
