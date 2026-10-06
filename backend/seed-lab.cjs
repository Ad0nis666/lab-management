const { AuthStore } = require('./auth.cjs');
const { CollectionStore } = require('./collections.cjs');
const { ReagentStore } = require('./reagents.cjs');
const { BottleStore, today } = require('./bottles.cjs');
function seedLab(auth, { stock = false } = {}) {
  const user = auth.db.prepare("SELECT id, role, display_name FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at LIMIT 1").get();
  if (!user) throw new Error('请先初始化管理员。');
  const instruments = new CollectionStore(auth, 'instruments'), reagents = new ReagentStore(auth);
  const created = { instruments: 0, reagents: 0, ...(stock ? { bottles: 0 } : {}) };
  // Explicit one-time local setup, never seed automatically on application startup.
  for (const [code, name, kind] of [['LAB-ROBOT-001', '机械臂', 'robot'], ['LAB-BALANCE-001', '天平', 'balance'], ['LAB-PUMP-001', '药瓶泵', 'pump']]) {
    if (!auth.db.prepare('SELECT 1 FROM instruments WHERE code = ?').get(code)) {
      instruments.save({ code, name, kind, status: 'unknown' }, user); created.instruments++;
    }
  }
  for (const [name, stock_unit] of [['水', 'L'], ['醋酸', 'L'], ['碳酸钠', 'L']]) {
    if (!auth.db.prepare('SELECT 1 FROM reagents WHERE name = ?').get(name)) {
      reagents.create({ name, stock_unit, low_stock_threshold: '0' }, user); created.reagents++;
    }
    if (stock) {
      const reagent = auth.db.prepare('SELECT * FROM reagents WHERE name = ? ORDER BY created_at LIMIT 1').get(name);
      const bottle_code = 'INITIAL-' + ({ '水': 'WATER', '醋酸': 'ACETIC-ACID', '碳酸钠': 'SODIUM-CARBONATE' })[name];
      if (!auth.db.prepare('SELECT 1 FROM reagent_bottles WHERE bottle_code = ?').get(bottle_code)) {
        const bottles = new BottleStore(auth, reagents);
        bottles.create(reagent.id, { bottle_code, initial_quantity: '1', unit: 'L', location: '', batch_no: '', received_on: today(auth.now()), expires_on: '' }, user, 'seed-stock-' + bottle_code);
        created.bottles++;
      }
    }
  }
  return created;
}
if (require.main === module) {
  const auth = new AuthStore({ dbPath: process.env.LAB_DB_PATH });
  try { console.log(JSON.stringify(seedLab(auth, { stock: process.argv.includes('--stock') }))); } catch (error) { console.error(error.message); process.exitCode = 1; } finally { auth.close(); }
}
module.exports = { seedLab };
