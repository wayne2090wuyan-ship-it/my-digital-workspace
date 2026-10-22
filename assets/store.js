/* 数据访问层：仅内存。未来可用同一接口替换为受身份验证保护的仓储。 */
(function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  let state = clone(window.LearningDemo);
  const collections = ['tasks','papers','academic','fitness','life'];
  window.LearningStore = Object.freeze({
    read() { return clone(state); },
    update(collection, id, field, value) {
      if (!collections.includes(collection)) throw new Error('未知数据集合');
      const record = state[collection].find(item => item.id === id);
      if (!record) throw new Error('找不到演示记录');
      const allowed = collection === 'papers' ? 'stage' : collection === 'academic' ? 'saved' : 'done';
      if (field !== allowed) throw new Error('不可修改此字段');
      if (field === 'stage' ? !Number.isInteger(value) || value < 0 || value > 4 : typeof value !== 'boolean') throw new Error('无效演示状态');
      record[field] = value;
    },
    reset() { state = clone(window.LearningDemo); }
  });
})();
