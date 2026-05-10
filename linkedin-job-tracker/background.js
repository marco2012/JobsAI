// MV3 service worker — storage and downloads handled by popup + content scripts
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('trackedJobs', ({ trackedJobs }) => {
    if (!trackedJobs) chrome.storage.local.set({ trackedJobs: [] });
  });
});
