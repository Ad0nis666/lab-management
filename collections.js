const collectionTitles = { instruments: '仪器', samples: '样本' };
const collectionStatuses = { unknown: ['待确认', 'info'], normal: ['运行正常', 'success'], fault: ['故障', 'danger'], calibration: ['待校准', 'warning'], maintenance: ['维护中', 'warning'], stored: ['在库', 'success'], in_use: ['使用中', 'info'], exhausted: ['已用尽', 'warning'], discarded: ['已废弃', 'danger'] };
const instrumentImages = { robot: 'assets/instruments/robot-arm.svg', balance: 'assets/instruments/balance.svg', pump: 'assets/instruments/bottle-pump.svg' };
const collectionState = Object.fromEntries(Object.keys(collectionTitles).map(kind => [kind, { page: 1, request: 0, edit: null }]));
function collectionStatus(status) { const [label, color] = collectionStatuses[status]; return textElement('span', label, `status status-${color}`); }
function collectionImage(item, className = '') {
  if (!instrumentImages[item.kind]) return textElement('div', '仪器', className);
  const image = document.createElement('img'); image.src = instrumentImages[item.kind]; image.alt = `${item.name}卡通示意图`; image.width = 480; image.height = 320; image.className = className; return image;
}
function collectionButton(label, handler, write = false) {
  const button = textElement('button', label, 'card-link'); button.type = 'button';
  if (write) button.dataset.writeAction = '';
  button.addEventListener('click', handler); return button;
}
async function loadCollection(kind) {
  const state = collectionState[kind], request = ++state.request;
  const list = document.querySelector(`#${kind}-list`), message = document.querySelector(`#${kind}-message`);
  const prev = document.querySelector(`#${kind}-prev`), next = document.querySelector(`#${kind}-next`), info = document.querySelector(`#${kind}-page-info`);
  message.textContent = '正在加载…'; list.replaceChildren(); prev.disabled = next.disabled = true; info.textContent = ''; document.querySelector(`#${kind}-retry`).hidden = true;
  try {
    const result = await businessRequest(`/api/v1/${kind}?${new URLSearchParams({ q: document.querySelector(`#${kind}-search`).value.trim(), page: state.page, page_size: 12 })}`);
    if (request !== state.request) return;
    message.textContent = result.total ? '' : `暂无匹配的${collectionTitles[kind]}记录。`;
    if (kind === 'samples' && result.items.length) {
      const header = textElement('div', '', 'sample-row sample-head');
      ['编号 / 名称', '所属项目', '数量', '存放位置', '状态 / 操作'].forEach(label => header.append(textElement('span', label))); list.append(header);
    }
    result.items.forEach(item => {
      const card = textElement('article', '', kind === 'instruments' ? 'instrument-card' : 'sample-row');
      if (kind === 'instruments') {
        const visual = textElement('div', '', 'instrument-visual'); visual.append(collectionImage(item), collectionStatus(item.status));
        card.append(visual, textElement('h3', item.name), textElement('p', `${item.code} · ${item.model || '型号待填写'}`), textElement('p', `位置：${item.location || '待填写'} · 负责人：${item.owner || '待填写'}`), textElement('p', `下次校准：${item.calibration_on || '待确认'}`));
      } else {
        const identity = textElement('div', ''); identity.append(textElement('strong', item.code), textElement('p', item.name));
        card.append(identity, textElement('span', item.project || '未填写'), textElement('span', `${item.quantity} ${item.unit}`), textElement('span', item.location));
      }
      const actions = textElement('div', '', 'collection-actions');
      if (kind === 'samples') actions.append(collectionStatus(item.status));
      actions.append(collectionButton('查看详情', () => openCollectionDetail(kind, item.id)), collectionButton('编辑', () => openCollectionForm(kind, item), true));
      card.append(actions); list.append(card);
    });
    const pages = Math.max(1, Math.ceil(result.total / result.page_size));
    info.textContent = `共 ${result.total} 条 · 第 ${result.page} / ${pages} 页`; prev.disabled = result.page <= 1; next.disabled = result.page >= pages;
  } catch (error) {
    if (request !== state.request) return;
    message.textContent = error.message; document.querySelector(`#${kind}-retry`).hidden = false;
  }
}
let equipmentRequest = 0;
async function loadEquipmentSummary() {
  const request = ++equipmentRequest, list = document.querySelector('#equipment-summary');
  list.replaceChildren(textElement('p', '正在加载仪器…', 'collection-feedback'));
  try {
    const [result, summary] = await Promise.all([businessRequest('/api/v1/instruments?page_size=3'), businessRequest('/api/v1/collections-summary')]);
    if (request !== equipmentRequest) return;
    document.querySelector('#metric-instruments').textContent = `${summary.instruments.available} / ${summary.instruments.total}`;
    document.querySelector('#metric-instruments-hint').textContent = `${summary.instruments.unconfirmed} 台状态待确认`;
    document.querySelector('#metric-samples').textContent = summary.samples.stored;
    document.querySelector('#equipment-pending-count').textContent = summary.instruments.total - summary.instruments.available;
    const pending = document.querySelector('#equipment-pending'); pending.replaceChildren();
    if (!summary.pending.length) pending.append(textElement('li', '暂无待确认或待处理的仪器。', 'equipment-pending-empty'));
    summary.pending.forEach(item => {
      const row = textElement('li', ''), copy = textElement('div', '');
      copy.append(textElement('strong', `${item.name} · ${collectionStatuses[item.status][0]}`), textElement('p', item.code));
      row.append(copy, collectionButton('查看详情', () => openCollectionDetail('instruments', item.id))); pending.append(row);
    });
    list.replaceChildren();
    if (!result.items.length) list.append(textElement('p', '暂无仪器记录。', 'collection-feedback'));
    result.items.forEach(item => {
      const card = textElement('article', '', 'equipment-item'), copy = textElement('div', '');
      copy.append(textElement('strong', item.name), textElement('small', `${item.code} · ${item.location || '位置待填写'}`));
      card.append(collectionImage(item, 'equipment-thumb'), copy, collectionStatus(item.status)); list.append(card);
    });
  } catch (error) {
    if (request !== equipmentRequest) return;
    for (const id of ['metric-instruments', 'metric-samples', 'equipment-pending-count']) document.querySelector('#' + id).textContent = '—';
    document.querySelector('#metric-instruments-hint').textContent = '汇总加载失败';
    document.querySelector('#equipment-pending').replaceChildren();
    list.replaceChildren(textElement('p', error.message, 'collection-feedback'), collectionButton('重试仪器状态', loadEquipmentSummary));
  }
}
async function openCollectionForm(kind, item = null) {
  if (!await requireInformationWrite()) return;
  const form = document.querySelector(`#${kind}-form`), dialog = document.querySelector(`#${kind}-dialog`);
  collectionState[kind].edit = item; form.reset();
  if (item) for (const input of form.querySelectorAll('[name]')) input.value = item[input.name];
  document.querySelector(`#${kind}-error`).textContent = '';
  document.querySelector(`#${kind}-dialog-title`).textContent = `${item ? '编辑' : '登记'}${collectionTitles[kind]}`;
  document.querySelector('#collection-detail-dialog').close(); if (!dialog.open) dialog.showModal();
}
let collectionDetailRequest = 0, collectionDetailTarget;
async function openCollectionDetail(kind, id) {
  collectionDetailTarget = { kind, id };
  const request = ++collectionDetailRequest, dialog = document.querySelector('#collection-detail-dialog');
  const content = document.querySelector('#collection-detail'), message = document.querySelector('#collection-detail-message'), edit = document.querySelector('#collection-detail-edit');
  content.replaceChildren(); message.textContent = '正在加载详情…'; edit.hidden = true; document.querySelector('#collection-detail-retry').hidden = true;
  document.querySelector('#collection-detail-title').textContent = `${collectionTitles[kind]}详情`; if (!dialog.open) dialog.showModal();
  try {
    const { item } = await businessRequest(`/api/v1/${kind}/${encodeURIComponent(id)}`);
    if (request !== collectionDetailRequest) return;
    message.textContent = ''; document.querySelector('#collection-detail-title').textContent = item.name;
    const labels = { code: '编号', name: '名称', model: '型号', location: '存放位置', owner: '负责人', status: '状态', calibration_on: '下次校准', project: '项目', quantity: '数量', unit: '单位', notes: '备注', created_at: '创建时间', updated_at: '更新时间' };
    for (const [key, label] of Object.entries(labels)) if (Object.hasOwn(item, key)) {
      const row = textElement('div', ''); row.append(textElement('dt', label), textElement('dd', key === 'status' ? collectionStatuses[item[key]][0] : item[key] || '未填写')); content.append(row);
    }
    edit.hidden = false; edit.onclick = () => openCollectionForm(kind, item);
  } catch (error) { if (request !== collectionDetailRequest) return; message.textContent = error.message; document.querySelector('#collection-detail-retry').hidden = false; }
}
document.querySelector('#collection-detail-dialog').addEventListener('close', () => { collectionDetailRequest++; });
document.querySelector('#collection-detail-retry').addEventListener('click', () => openCollectionDetail(collectionDetailTarget.kind, collectionDetailTarget.id));
for (const kind of Object.keys(collectionTitles)) {
  document.querySelector(`#${kind}-dialog`).addEventListener('cancel', event => {
    if (document.querySelector(`#${kind}-form [type="submit"]`).disabled) event.preventDefault();
  });
  document.querySelector(`[data-new-collection="${kind}"]`).addEventListener('click', () => openCollectionForm(kind));
  document.querySelectorAll(`[data-close-collection="${kind}"]`).forEach(button => button.addEventListener('click', () => document.querySelector(`#${kind}-dialog`).close()));
  document.querySelector(`#${kind}-search`).addEventListener('input', () => { collectionState[kind].page = 1; loadCollection(kind); });
  document.querySelector(`#${kind}-prev`).addEventListener('click', () => { collectionState[kind].page--; loadCollection(kind); });
  document.querySelector(`#${kind}-next`).addEventListener('click', () => { collectionState[kind].page++; loadCollection(kind); });
  document.querySelector(`#${kind}-retry`).addEventListener('click', () => loadCollection(kind));
  document.querySelector(`#${kind}-form`).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target, submit = form.querySelector('[type="submit"]'); if (submit.disabled) return;
    const data = Object.fromEntries(new FormData(form)), item = collectionState[kind].edit;
    if (item) data.version = item.version;
    const controls = [...form.querySelectorAll('input,select,button')], errorMessage = document.querySelector(`#${kind}-error`);
    errorMessage.textContent = ''; controls.forEach(control => { control.disabled = true; }); submit.textContent = '正在保存…';
    try {
      await businessRequest(`/api/v1/${kind}${item ? '/' + encodeURIComponent(item.id) : ''}`, data);
      document.querySelector(`#${kind}-dialog`).close(); form.reset();
      collectionState[kind].page = 1; document.querySelector(`#${kind}-search`).value = '';
      await loadCollection(kind); await loadEquipmentSummary();
      if (kind === 'instruments') await loadDashboard();
      toast.querySelector('span').textContent = `${collectionTitles[kind]}已保存`; toast.classList.add('is-visible'); window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
    } catch (error) { errorMessage.textContent = error.message; errorMessage.focus(); }
    finally { controls.forEach(control => { control.disabled = false; }); submit.textContent = `保存${collectionTitles[kind]}`; }
  });
}
loadEquipmentSummary();
