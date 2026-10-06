const permissionMessage = '您没有该权限';
let permissionRole;
window.addEventListener('lab-session', event => { permissionRole = event.detail.role; });
function showPermissionDenied() { window.alert(permissionMessage); }
async function requireInformationWrite() {
  // Identity presentation can fail independently of an otherwise valid session.
  if (!permissionRole) {
    try {
      const response = await fetch('/api/v1/users', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (response.status === 401) { window.location.replace('./login.html'); return false; }
      if (!response.ok) throw new Error('Permission lookup failed');
      const data = await response.json();
      permissionRole = data.can_modify_information === true ? 'admin' : 'member';
    } catch { showPermissionDenied(); return false; }
  }
  if (permissionRole !== 'admin') { showPermissionDenied(); return false; }
  return true;
}
// Capture before individual action listeners, including dynamically rendered buttons.
document.addEventListener('click', async event => {
  const button = event.target instanceof Element ? event.target.closest('button[data-write-action]') : null;
  if (!button || permissionRole === 'admin') return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (await requireInformationWrite()) button.click();
}, true);
// Covers Enter and scripted submission as well as clicks on Save.
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches('form[data-write-form]') || permissionRole === 'admin') return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (await requireInformationWrite()) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}, true);
