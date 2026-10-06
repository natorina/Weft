const origin = new URLSearchParams(location.search).get('origin') || '';
const valid = /^https?:\/\/[^/]+$/.test(origin);
const host = valid ? new URL(origin).host.replace(/^www\./, '') : '';
for (const el of document.querySelectorAll('.host')) el.textContent = host;
const status = document.querySelector('.status');

document.getElementById('cancel').addEventListener('click', () => window.close());
document.getElementById('on').addEventListener('click', async () => {
  if (!valid) return;
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
  if (granted) {
    status.textContent = `Done. Weft will now open by itself on ${host}.`;
    setTimeout(() => window.close(), 1600);
  } else {
    status.textContent = 'Not turned on.';
  }
});
