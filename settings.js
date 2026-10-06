let membersPage = 1, membersRequest = 0, remindersRequest = 0, reminderRules, settingsUser, memberSaving = false, remindersSaving = false;
const membersForm = document.querySelector('#members-filter');
const remindersForm = document.querySelector('#reminders-form');
window.addEventListener('lab-session', event => {
  settingsUser = event.detail;
  if (reminderRules) document.querySelector('#reminders-fields').disabled = remindersSaving || settingsUser.role !== 'admin';
});
function showSettingsHome() {
  document.querySelector('#settings-home').hidden = false;
  document.querySelector('#settings-content').hidden = true;
}
function showSettingsView(view) {
  document.querySelector('#settings-home').hidden = true;
  document.querySelector('#settings-content').hidden = false;
  for (const name of ['members', 'reminders', 'help']) document.querySelector(`#settings-${name}`).hidden = name !== view;
  const title = document.querySelector('#settings-title');
  title.textContent = { members: '成员与角色', reminders: '提醒规则', help: '使用帮助' }[view]; title.focus();
  if (view === 'members') { membersPage = 1; loadSettingsMembers(); }
  if (view === 'reminders') loadReminderSettings();
}
document.querySelectorAll('[data-settings-view]').forEach(button => button.addEventListener('click', () => showSettingsView(button.dataset.settingsView)));
document.querySelector('#settings-back').addEventListener('click', () => {
  const previous = ['members', 'reminders', 'help'].find(name => !document.querySelector(`#settings-${name}`).hidden);
  showSettingsHome(); document.querySelector(`[data-settings-view="${previous}"]`).focus();
});
function settingsDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未保存'; }
async function loadSettingsMembers(feedback = '') {
  const request = ++membersRequest, body = document.querySelector('#members-body'), message = document.querySelector('#members-message');
  body.replaceChildren(); body.setAttribute('aria-busy', 'true'); message.textContent = '正在加载成员…'; message.dataset.error = 'false';
  document.querySelector('#members-summary').textContent = ''; document.querySelector('#members-page-info').textContent = '';
  document.querySelector('#members-retry').hidden = true;
  document.querySelector('#members-prev').disabled = document.querySelector('#members-next').disabled = true;
  try {
    const query = new URLSearchParams(new FormData(membersForm)); query.set('page', membersPage); query.set('page_size', 12);
    const result = await businessRequest(`/api/v1/settings/members?${query}`);
    if (request !== membersRequest) return;
    const pages = Math.max(1, Math.ceil(result.total / result.page_size));
    if (membersPage > pages) { membersPage = pages; return loadSettingsMembers(feedback); }
    document.querySelector('#members-summary').textContent = `共 ${result.summary.total} 位成员 · ${result.summary.active_admins} 位有效管理员`;
    for (const member of result.items) {
      const row = document.createElement('tr'); row.dataset.memberId = member.id;
      const identity = textElement('td', ''); identity.append(textElement('strong', member.display_name), textElement('small', member.account));
      const dates = textElement('td', ''); dates.append(textElement('span', settingsDate(member.created_at)), textElement('small', settingsDate(member.updated_at)));
      const actions = textElement('td', ''), group = textElement('div', '', 'member-actions');
      for (const [label, changes] of [[member.role === 'admin' ? '设为普通成员' : '设为管理员', { role: member.role === 'admin' ? 'member' : 'admin' }], [member.active ? '停用账号' : '恢复账号', { active: !member.active }]]) {
        const button = textElement('button', label, 'table-action'); button.type = 'button'; button.dataset.writeAction = ''; button.disabled = memberSaving;
        button.addEventListener('click', () => saveMember(member, changes, label)); group.append(button);
      }
      actions.append(group); row.append(identity, textElement('td', member.role === 'admin' ? '管理员' : '普通成员'), textElement('td', member.active ? '启用' : '停用'), dates, actions); body.append(row);
    }
    message.textContent = feedback || (result.total ? '' : '暂无匹配的成员。');
    document.querySelector('#members-page-info').textContent = `第 ${result.page} / ${pages} 页 · ${result.total} 位`;
    document.querySelector('#members-prev').disabled = membersPage <= 1; document.querySelector('#members-next').disabled = membersPage >= pages;
  } catch (error) {
    if (request !== membersRequest) return;
    message.dataset.error = 'true'; message.textContent = `成员加载失败：${error.message}`; document.querySelector('#members-retry').hidden = false;
  } finally { if (request === membersRequest) body.setAttribute('aria-busy', 'false'); }
}
async function saveMember(member, changes, label) {
  if (memberSaving || !await requireInformationWrite()) return;
  const impact = changes.active === false ? '该成员将无法登录，历史记录保留。' : changes.active === true ? '恢复后该成员需要重新登录。' : changes.role === 'admin' ? '该成员将获得全部管理员权限，包括业务登记、修改和设置管理。' : '该成员将仅保留查询权限。';
  if (!window.confirm(`确认对 ${member.display_name}（${member.account}）执行“${label}”？\n${impact}\n权限或状态变化会撤销原有登录会话。`)) return;
  memberSaving = true;
  document.querySelectorAll('#members-body button').forEach(button => { button.disabled = true; });
  const message = document.querySelector('#members-message'); message.dataset.error = 'false'; message.textContent = '正在保存…';
  try {
    await businessRequest(`/api/v1/settings/members/${encodeURIComponent(member.id)}`, { ...changes, version: member.version }, {}, 'PATCH');
    if (settingsUser?.id === member.id) { window.location.replace('./login.html'); return; }
    await loadSettingsMembers('成员设置已保存；该成员需要重新登录。');
  } catch (error) {
    message.dataset.error = 'true'; message.textContent = error.message;
    if (error.status === 409) document.querySelector('#members-retry').hidden = false;
  } finally { memberSaving = false; document.querySelectorAll('#members-body button').forEach(button => { button.disabled = false; }); }
}
membersForm.addEventListener('submit', event => { event.preventDefault(); membersPage = 1; loadSettingsMembers(); });
document.querySelector('#members-prev').addEventListener('click', () => { membersPage--; loadSettingsMembers(); });
document.querySelector('#members-next').addEventListener('click', () => { membersPage++; loadSettingsMembers(); });
document.querySelector('#members-retry').addEventListener('click', () => loadSettingsMembers());
async function loadReminderSettings() {
  if (remindersSaving) return;
  const request = ++remindersRequest, message = document.querySelector('#reminders-message'); reminderRules = null;
  document.querySelector('#reminders-fields').disabled = true; document.querySelector('#reminders-save').disabled = true;
  remindersForm.reset(); document.querySelector('#reminders-updated').textContent = ''; message.dataset.error = 'false'; message.textContent = '正在加载规则…'; document.querySelector('#reminders-retry').hidden = true;
  try {
    const { settings } = await businessRequest('/api/v1/settings/reminders');
    if (request !== remindersRequest) return;
    reminderRules = settings;
    for (const key of ['low_enabled', 'expiry_enabled', 'calibration_enabled']) remindersForm.elements[key].checked = settings[key];
    for (const key of ['expiry_days', 'calibration_days']) { remindersForm.elements[key].value = settings[key]; remindersForm.elements[key].max = settings.max_days; }
    document.querySelector('#reminders-updated').textContent = `最近保存：${settingsDate(settings.updated_at)}`;
    document.querySelector('#reminders-fields').disabled = settingsUser?.role !== 'admin'; document.querySelector('#reminders-save').disabled = false;
    message.textContent = settingsUser?.role === 'admin' ? '修改后保存，工作台将使用最新规则。' : '当前规则仅供查看，修改由管理员完成。';
  } catch (error) {
    if (request !== remindersRequest) return;
    message.dataset.error = 'true'; message.textContent = `规则加载失败：${error.message}`; document.querySelector('#reminders-retry').hidden = false;
  }
}
for (const id of ['reminders-retry', 'reminders-reload']) document.querySelector(`#${id}`).addEventListener('click', loadReminderSettings);
remindersForm.addEventListener('submit', async event => {
  event.preventDefault(); if (!await requireInformationWrite() || !reminderRules) return;
  const message = document.querySelector('#reminders-message'), save = document.querySelector('#reminders-save'); if (save.disabled) return;
  const data = { version: reminderRules.version };
  for (const key of ['low_enabled', 'expiry_enabled', 'calibration_enabled']) data[key] = remindersForm.elements[key].checked;
  for (const key of ['expiry_days', 'calibration_days']) {
    const value = remindersForm.elements[key].value;
    if (!/^\d+$/.test(value) || Number(value) > reminderRules.max_days) { message.dataset.error = 'true'; message.textContent = `提前天数须为 0–${reminderRules.max_days} 的整数。`; return; }
    data[key] = Number(value);
  }
  // Prevent a delayed reload from replacing the version and feedback of a save.
  ++remindersRequest; remindersSaving = true; save.disabled = true; document.querySelector('#reminders-fields').disabled = true;
  document.querySelector('#reminders-reload').disabled = true; document.querySelector('#reminders-retry').hidden = true;
  message.dataset.error = 'false'; message.textContent = '正在保存…';
  try {
    const { settings } = await businessRequest('/api/v1/settings/reminders', data, {}, 'PATCH'); reminderRules = settings;
    document.querySelector('#reminders-updated').textContent = `最近保存：${settingsDate(settings.updated_at)}`;
    message.textContent = '提醒规则已保存，工作台已刷新。'; await loadDashboard();
  } catch (error) {
    message.dataset.error = 'true'; message.textContent = error.message;
    if (error.status === 409) { reminderRules = null; document.querySelector('#reminders-retry').hidden = false; }
  } finally {
    remindersSaving = false; save.disabled = !reminderRules; document.querySelector('#reminders-fields').disabled = !reminderRules || settingsUser?.role !== 'admin'; document.querySelector('#reminders-reload').disabled = false;
  }
});
