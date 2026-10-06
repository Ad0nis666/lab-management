const { AuthError } = require('./auth.cjs');
const { SettingsStore } = require('./settings.cjs');
const { today } = require('./bottles.cjs');
// Compare decimals as fixed-point integers, including five-place unit conversions.
function fixed(value) { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 100000n + BigInt(fraction.padEnd(5, '0')); }
class DashboardStore {
  constructor(auth, bottles) { this.auth = auth; this.db = auth.db; this.bottles = bottles; }
  get(params) {
    for (const key of params.keys()) if (!['page', 'page_size', 'type'].includes(key) || params.getAll(key).length !== 1) throw new AuthError(422, 'INVALID_DASHBOARD', '提醒查询参数不受支持。');
    const number = (key, fallback, max) => {
      const value = params.get(key) ?? String(fallback);
      if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) throw new AuthError(422, 'INVALID_DASHBOARD', '提醒分页参数不正确。');
      return Number(value);
    };
    const page = number('page', 1, 1000000), page_size = number('page_size', 12, 100), type = params.get('type') ?? 'all';
    if (!['all', 'low', 'expiry', 'expired', 'calibration'].includes(type)) throw new AuthError(422, 'INVALID_DASHBOARD', '提醒类型不正确。');
    return this.auth.transaction(() => {
      const currentDate = today(this.auth.now()), rules = new SettingsStore(this.auth).reminders(), expiryDays = rules.expiry_days;
      const deadline = new Date(currentDate + 'T00:00:00Z'); deadline.setUTCDate(deadline.getUTCDate() + expiryDays);
      const lastDate = deadline.toISOString().slice(0, 10);
      const metrics = { reagent_count: 0, stocked_reagent_count: 0, available_bottle_count: 0, low_stock_count: 0, expiring_bottle_count: 0, expired_bottle_count: 0, calibration_count: 0 };
      const alerts = [], lowIds = new Set();
      for (const reagent of this.db.prepare('SELECT * FROM reagents ORDER BY name, id').all()) {
        metrics.reagent_count++;
        const summary = this.bottles.summary(reagent, currentDate);
        if (fixed(summary.total_quantity) > 0n) metrics.stocked_reagent_count++;
        metrics.available_bottle_count += summary.available_bottle_count;
        if (rules.low_enabled && fixed(summary.available_quantity) < fixed(reagent.low_stock_threshold)) {
          metrics.low_stock_count++; lowIds.add(reagent.id);
          alerts.push({ key: `low:${reagent.id}`, type: 'low', tags: ['low'], reagent_id: reagent.id, reagent_name: reagent.name, bottle_id: null, bottle_code: null, location: '按档案汇总', quantity: summary.available_quantity, unit: reagent.stock_unit, threshold: reagent.low_stock_threshold });
        }
      }
      const rows = this.db.prepare("SELECT b.*, r.name AS reagent_name FROM reagent_bottles b JOIN reagents r ON r.id = b.reagent_id WHERE b.lifecycle_status = 'in_stock' AND b.remaining_minor > 0 AND b.expires_on <= ? ORDER BY b.expires_on, b.bottle_code, b.id").all(lastDate);
      for (const row of rows) {
        const expired = row.expires_on < currentDate, alertType = expired ? 'expired' : 'expiry';
        if (!expired && !rules.expiry_enabled) continue;
        metrics[expired ? 'expired_bottle_count' : 'expiring_bottle_count']++;
        alerts.push({ key: `${alertType}:${row.id}`, type: alertType, tags: [alertType, ...(lowIds.has(row.reagent_id) ? ['low'] : [])], reagent_id: row.reagent_id, reagent_name: row.reagent_name, bottle_id: row.id, bottle_code: row.bottle_code, location: row.location, quantity: this.bottles.publicBottle(row).remaining_quantity, unit: row.unit, expires_on: row.expires_on, days_until_expiry: Math.round((Date.parse(row.expires_on + 'T00:00:00Z') - Date.parse(currentDate + 'T00:00:00Z')) / 86400000) });
      }
      const calibrationDeadline = new Date(currentDate + 'T00:00:00Z');
      calibrationDeadline.setUTCDate(calibrationDeadline.getUTCDate() + rules.calibration_days);
      if (rules.calibration_enabled) {
        for (const item of this.db.prepare("SELECT * FROM instruments WHERE calibration_on != '' AND calibration_on <= ? ORDER BY calibration_on, code, id").all(calibrationDeadline.toISOString().slice(0, 10))) {
          metrics.calibration_count++;
          alerts.push({ key: `calibration:${item.id}`, type: 'calibration', tags: ['calibration'], instrument_id: item.id, instrument_name: item.name, instrument_code: item.code, location: item.location || '未填写', calibration_on: item.calibration_on, days_until_calibration: Math.round((Date.parse(item.calibration_on + 'T00:00:00Z') - Date.parse(currentDate + 'T00:00:00Z')) / 86400000) });
        }
      }
      const priority = { expired: 0, calibration: 1, low: 2, expiry: 3 };
      alerts.sort((a, b) => priority[a.type] - priority[b.type]);
      const filtered = alerts.filter(item => type === 'all' || item.type === type);
      return { today: currentDate, timezone: 'Asia/Shanghai', expiry_days: expiryDays, calibration_days: rules.calibration_days, reminder_settings: rules, metrics, counts: { all: alerts.length, low: metrics.low_stock_count, expiry: metrics.expiring_bottle_count, expired: metrics.expired_bottle_count, calibration: metrics.calibration_count }, items: filtered.slice((page - 1) * page_size, page * page_size), total: filtered.length, page, page_size };
    });
  }
}
module.exports = { DashboardStore };
