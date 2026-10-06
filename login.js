const form = document.querySelector('#login-form');
const account = document.querySelector('#account');
const password = document.querySelector('#password');
const toggle = document.querySelector('#toggle-password');
const submit = document.querySelector('#login-button');
const submitLabel = document.querySelector('#login-button-label');
const message = document.querySelector('#login-message');
const touched = new Set();

function setState(state, text = '') {
  submit.dataset.state = state;
  message.dataset.state = state;
  message.textContent = text;
  const busy = state === 'loading' || state === 'success';
  submit.disabled = busy;
  document.querySelector('#show-register').disabled = busy;
  submit.setAttribute('aria-busy', String(state === 'loading'));
  form.setAttribute('aria-busy', String(state === 'loading'));
  submitLabel.textContent = state === 'loading' ? '正在登录…' : state === 'success' ? '登录成功' : '登录';
  [account, password].forEach(field => {
    field.disabled = busy;
    field.dataset.state = state === 'loading' || state === 'success' ? state : 'default';
  });
}
function validateField(field) {
  const empty = !field.value.trim();
  const helper = document.querySelector(`#${field.id}-error`);
  helper.textContent = empty ? `请填写${field === account ? '账号' : '密码'}。` : '';
  if (empty) field.setAttribute('aria-invalid', 'true');
  else field.removeAttribute('aria-invalid');
  return !empty;
}
[account, password].forEach(field => {
  field.addEventListener('blur', () => { touched.add(field); validateField(field); });
  field.addEventListener('input', () => {
    if (touched.has(field)) validateField(field);
    setState('default');
  });
});

const registerForm = document.querySelector('#register-form');
const registerFields = [...registerForm.querySelectorAll('input')];
const registerButton = document.querySelector('#register-button');
const registerMessage = document.querySelector('#register-message');
const registerTouched = new Set();
const registerPassword = document.querySelector('#register-password');
const registerConfirm = document.querySelector('#register-confirm');
const registerToggle = document.querySelector('#toggle-register-password');

function setRegistrationState(state, text = '') {
  const busy = state === 'loading';
  registerButton.dataset.state = state;
  registerMessage.dataset.state = state;
  registerMessage.textContent = text;
  registerForm.setAttribute('aria-busy', String(busy));
  registerForm.querySelectorAll('input, button').forEach(control => { control.disabled = busy; });
  document.querySelector('#show-login').disabled = busy;
  document.querySelector('#register-button-label').textContent = busy ? '正在注册…' : '注册账号';
}
function showAuthForm(registering) {
  if (submit.disabled || registerButton.disabled) return;
  form.hidden = registering;
  registerForm.hidden = !registering;
  document.querySelector('#login-switch').hidden = registering;
  document.querySelector('#register-switch').hidden = !registering;
  document.querySelector('.login-content').classList.toggle('is-register', registering);
  document.querySelector('#login-title').textContent = registering ? '注册账号' : '账号登录';
  document.querySelector('.login-heading p').textContent = registering ? '填写信息，创建实验室成员账号。' : '登录后进入实验室台账管理平台。';
  document.title = `${registering ? '注册账号' : '账号登录'} · 实验室台账管理平台`;
  password.value = '';
  password.type = 'password'; toggle.textContent = '显示'; toggle.setAttribute('aria-label', '显示密码'); toggle.setAttribute('aria-pressed', 'false');
  touched.clear();
  [account, password].forEach(field => { field.removeAttribute('aria-invalid'); document.querySelector(`#${field.id}-error`).textContent = ''; });
  registerForm.reset(); registerTouched.clear();
  registerFields.forEach(field => { field.removeAttribute('aria-invalid'); document.querySelector(`#${field.id}-error`).textContent = ''; });
  registerPassword.type = 'password'; registerToggle.textContent = '显示'; registerToggle.setAttribute('aria-label', '显示注册密码'); registerToggle.setAttribute('aria-pressed', 'false');
  setState('default'); setRegistrationState('default');
  (registering ? registerFields[0] : account).focus();
}
document.querySelector('#show-register').addEventListener('click', () => showAuthForm(true));
document.querySelector('#show-login').addEventListener('click', () => showAuthForm(false));

function validateRegistrationField(field) {
  const value = field.value;
  let error = '';
  if (!value.trim()) error = `请填写${field.labels[0].textContent}。`;
  else if (field.name === 'display_name' && value.trim().length > 40) error = '姓名最多填写 40 字。';
  else if (field.name === 'account' && !/^[a-zA-Z0-9_.@-]{3,80}$/.test(value.trim())) error = '账号须为 3–80 位字母、数字或 _ . @ -。';
  else if (field.name === 'password' && (value.length < 9 || value.length > 128)) error = '密码须为 9–128 位。';
  else if (field === registerConfirm && value !== registerPassword.value) error = '两次密码不一致。';
  document.querySelector(`#${field.id}-error`).textContent = error;
  if (error) field.setAttribute('aria-invalid', 'true'); else field.removeAttribute('aria-invalid');
  return !error;
}
registerFields.forEach(field => {
  field.addEventListener('blur', () => { registerTouched.add(field); validateRegistrationField(field); });
  field.addEventListener('input', () => {
    if (registerTouched.has(field)) validateRegistrationField(field);
    if (field === registerPassword && registerTouched.has(registerConfirm)) validateRegistrationField(registerConfirm);
    setRegistrationState('default');
  });
});
registerToggle.addEventListener('click', () => {
  const visible = registerPassword.type === 'password';
  registerPassword.type = visible ? 'text' : 'password';
  registerToggle.textContent = visible ? '隐藏' : '显示';
  registerToggle.setAttribute('aria-label', visible ? '隐藏注册密码' : '显示注册密码');
  registerToggle.setAttribute('aria-pressed', String(visible));
});
registerForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (registerButton.disabled) return;
  const valid = registerFields.map(field => { registerTouched.add(field); return validateRegistrationField(field); });
  if (valid.includes(false)) { setRegistrationState('error', '请检查填写的信息。'); registerFields[valid.indexOf(false)].focus(); return; }
  const data = Object.fromEntries(new FormData(registerForm));
  data.account = data.account.trim(); data.display_name = data.display_name.trim();
  setRegistrationState('loading');
  try {
    const response = await fetch('/api/v1/auth/register', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) {
      setRegistrationState('error', result.error?.message || '注册失败，请稍后重试。');
      const fieldId = { ACCOUNT_EXISTS: 'register-account', INVALID_ACCOUNT: 'register-account', INVALID_PASSWORD: 'register-password', PASSWORD_MISMATCH: 'register-confirm', INVALID_USER: 'register-name' }[result.error?.code];
      if (fieldId) {
        const field = document.querySelector(`#${fieldId}`); field.setAttribute('aria-invalid', 'true');
        document.querySelector(`#${fieldId}-error`).textContent = result.error.message; field.focus();
      }
      return;
    }
    setRegistrationState('default'); showAuthForm(false);
    account.value = result.user.account;
    setState('default', '注册成功，请输入密码登录。');
    message.dataset.state = 'success'; password.focus();
  } catch (error) {
    setRegistrationState('error', ['TimeoutError', 'AbortError'].includes(error.name) ? '注册请求超时，请重试。' : '无法连接注册服务，请稍后重试。');
  }
});
toggle.addEventListener('click', () => {
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  toggle.textContent = visible ? '隐藏' : '显示';
  toggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  toggle.setAttribute('aria-pressed', String(visible));
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  const valid = [account, password].map(field => { touched.add(field); return validateField(field); });
  if (valid.includes(false)) {
    setState('error');
    [account, password][valid.indexOf(false)].focus();
    return;
  }
  const submittedAccount = account.value.trim();
  const submittedPassword = password.value;
  setState('loading');
  try {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: submittedAccount, password: submittedPassword }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) { setState('error', result.error?.message || '登录失败，请稍后重试。'); return; }
    setState('success', '登录成功，正在进入工作台。');
    window.location.assign('./index.html');
  } catch (error) {
    setState('error', ['TimeoutError', 'AbortError'].includes(error.name) ? '登录请求超时，请重试。' : '无法连接登录服务，请确认服务已启动后重试。');
  }
});
