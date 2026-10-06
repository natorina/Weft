// Clicking the toolbar button (or Alt+Shift+C) opens Weft on the current tab;
// clicking again closes it. Stores where "Run automatically" is on get it on every visit.

const AUTO_ID = 'weft-auto';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    // A manual click toggles the panel, even on a store where it already started by itself.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__weftAuto = false; } });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['parser.js', 'content.js'] });
  } catch (e) {
    // Browsers don't let extensions run on their own pages (settings, extension stores, etc.)
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#8f2d2d' });
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    chrome.action.setTitle({ tabId: tab.id, title: "Weft can't run on this page" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 3000);
  }
});

// Keep the automatic script registered for exactly the stores the user allowed.
async function syncAutoRun() {
  try {
    await registerAuto();
  } catch (e) {
    console.warn('Weft: could not update automatic sites', e);
  }
}

async function registerAuto() {
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = origins.filter((o) => /^https?:\/\/[^*]+\/\*$/.test(o));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_ID] });
  if (matches.length) {
    await chrome.scripting.registerContentScripts([
      { id: AUTO_ID, matches, js: ['auto-flag.js', 'parser.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true },
    ]);
  }
}

chrome.runtime.onInstalled.addListener(syncAutoRun);
chrome.runtime.onStartup.addListener(syncAutoRun);
chrome.permissions.onAdded.addListener(syncAutoRun);
chrome.permissions.onRemoved.addListener(syncAutoRun);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const pattern = msg.origin && /^https?:\/\/[^/]+$/.test(msg.origin) ? msg.origin + '/*' : null;
  if (!pattern) return;
  if (msg.type === 'auto-status') {
    chrome.permissions.contains({ origins: [pattern] }).then((on) => reply({ on }));
    return true;
  }
  if (msg.type === 'auto-enable') {
    // Permission has to be asked from an extension page, so open a small window for it.
    chrome.windows.create({
      url: chrome.runtime.getURL('enable.html?origin=' + encodeURIComponent(msg.origin)),
      type: 'popup',
      width: 440,
      height: 330,
    });
    reply({ ok: true });
    return;
  }
  if (msg.type === 'auto-disable') {
    chrome.permissions
      .remove({ origins: [pattern] })
      .then(syncAutoRun)
      .then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }
});
