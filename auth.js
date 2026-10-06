const profileButton = document.querySelector('.profile-button');
const profilePanel = document.querySelector('#profile-panel');
const logoutButton = document.querySelector('#logout-button');
const authMessage = document.querySelector('#auth-message');
const passwordDialog = document.querySelector('#password-dialog');
const passwordForm = document.querySelector('#password-form');
const passwordError = document.querySelector('#password-error');
let sessionDeadline;
let checkingSession;

function closeProfile(restoreFocus = false) {
  profilePanel.hidden = true;
  profileButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus) profileButton.focus();
}
async function authRequest(endpoint, body) {
  const response = await fetch(`/api/v1/auth/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  }).catch(error => { throw new Error(['TimeoutError', 'AbortError'].includes(error.name) ? '请求超时，请重试。' : '无法连接服务，请检查网络后重试。'); });
  const result = await response.json();
  if (response.status === 401) { window.location.replace('./login.html'); throw new Error('登录已失效，请重新登录。'); }
  if (!response.ok) {
    if (response.status === 403 && result.error?.code === 'FORBIDDEN') showPermissionDenied();
    throw new Error(result.error?.message || '操作失败，请稍后重试。');
  }
  return result;
}
async function refreshSession() {
  if (checkingSession) return;
  checkingSession = true;
  try {
    const { user, expires_at } = await authRequest('me');
    document.querySelector('.profile-copy strong').textContent = user.display_name;
    document.querySelector('.profile-copy strong').title = user.display_name;
    document.querySelector('.profile-copy small').textContent = user.role === 'admin' ? '管理员' : '普通成员';
    document.querySelector('.profile-button .avatar').textContent = user.display_name.slice(0, 1);
    document.querySelector('#profile-account').textContent = user.account;
    window.dispatchEvent(new CustomEvent('lab-session', { detail: user }));
    window.clearTimeout(sessionDeadline);
    sessionDeadline = window.setTimeout(() => window.location.replace('./login.html'), Math.max(0, Date.parse(expires_at) - Date.now()));
    authMessage.textContent = '';
  } catch (error) {
    authMessage.textContent = error.message || '无法检查登录状态，请刷新重试。';
    closeProfile();
  } finally { checkingSession = false; }
}
profileButton.addEventListener('click', () => {
  profilePanel.hidden = !profilePanel.hidden;
  profileButton.setAttribute('aria-expanded', String(!profilePanel.hidden));
  if (!profilePanel.hidden) document.querySelector('#change-password-button').focus();
});
document.addEventListener('click', event => { if (!event.target.closest('.profile-area')) closeProfile(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !profilePanel.hidden) closeProfile(true); });
document.addEventListener('focusin', event => { if (!event.target.closest('.profile-area') && !profilePanel.hidden) closeProfile(); });
logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  authMessage.textContent = '正在退出…';
  try { await authRequest('logout', {}); window.location.replace('./login.html'); }
  catch (error) { authMessage.textContent = error.message || '退出失败，请重试。'; logoutButton.disabled = false; }
});
document.querySelector('#change-password-button').addEventListener('click', () => {
  closeProfile(); passwordForm.reset(); passwordError.textContent = ''; passwordDialog.showModal();
});
document.querySelectorAll('[data-close-password]').forEach(button => button.addEventListener('click', () => passwordDialog.close()));
passwordDialog.addEventListener('close', () => { passwordForm.reset(); profileButton.focus(); });
passwordDialog.addEventListener('cancel', event => {
  if (passwordForm.querySelector('[type="submit"]').disabled) event.preventDefault();
});
passwordForm.addEventListener('submit', async event => {
  event.preventDefault();
  const fields = passwordForm.elements;
  if (fields.new_password.value !== fields.confirm_password.value) {
    passwordError.textContent = '两次新密码不一致。'; fields.confirm_password.focus(); return;
  }
  const button = passwordForm.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true; button.textContent = '正在保存…';
  const currentPassword = fields.current_password.value, newPassword = fields.new_password.value;
  const controls = [...passwordForm.querySelectorAll('input, button')];
  controls.forEach(control => { control.disabled = true; });
  try {
    await authRequest('change-password', { current_password: currentPassword, new_password: newPassword });
    window.location.replace('./login.html');
  } catch (error) { passwordError.textContent = error.message || '修改失败，请重试。'; }
  finally { controls.forEach(control => { control.disabled = false; }); button.textContent = '保存新密码'; }
});
window.addEventListener('pageshow', refreshSession);
window.addEventListener('focus', refreshSession);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSession(); });
refreshSession();
