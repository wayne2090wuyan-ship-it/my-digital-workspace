/* 界面层：渲染 DOM、绑定交互，通过仓储接口读取和更新演示状态。 */
(function () {
  'use strict';
  const store = window.LearningStore, domain = window.LearningDomain;
  const $ = id => document.getElementById(id);
  let selected = window.LearningDemo.baseline, year = 2026, month = 9;
  const dateKey = (y,m,d) => `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function announce(text) { $('status').textContent = text; }
  function change(collection, item, field, value) {
    store.update(collection,item.id,field,value);
    render();
    announce('演示状态已更新；刷新页面后恢复初始数据。');
  }
  function checklist(collection, target, records) {
    const root = $(target); root.replaceChildren();
    if (!records.length) root.append(el('p','当前筛选下暂无任务。','muted'));
    records.forEach(item => {
      const row = el('div',undefined,'row' + (item.done ? ' done' : ''));
      const label = el('label'), input = el('input');
      input.type='checkbox'; input.checked=item.done; input.dataset.focus=`${collection}-${item.id}`;
      input.addEventListener('change',()=>change(collection,item,'done',input.checked));
      const copy = el('span'); copy.append(el('span',item.title,'title'),el('span',`${item.date}${item.category ? ' · '+item.category : ''}`,'meta'));
      label.append(input,copy); row.append(label); root.append(row);
    });
  }
  function calendar(state) {
    $('month-label').textContent=`${year} 年 ${month+1} 月`;
    $('prev-month').disabled=year===2025 && month===0;
    $('next-month').disabled=year===2027 && month===11;
    const root=$('calendar-days'); root.replaceChildren();
    const offset=(new Date(year,month,1).getDay()+6)%7;
    for(let i=0;i<offset;i++) root.append(el('span'));
    const count=new Date(year,month+1,0).getDate();
    for(let d=1;d<=count;d++) {
      const key=dateKey(year,month,d), events=domain.events(state,key);
      const button=el('button',String(d),'day'+(events.length?' has-events':'')+(key===state.baseline?' baseline':''));
      button.type='button'; button.dataset.focus=key;
      button.setAttribute('aria-pressed',String(key===selected));
      button.setAttribute('aria-label',`${year}年${month+1}月${d}日，${events.length} 项演示安排`);
      button.addEventListener('click',()=>{selected=key;render();}); root.append(button);
    }
    $('selected-label').textContent=`${selected} · 当日安排`;
    $('agenda').replaceChildren();
    const events=domain.events(state,selected);
    if(!events.length) $('agenda').append(el('li','这一天暂无演示安排。','muted'));
    events.forEach(item=>{
      const li=el('li');li.append(el('span',item.kind,'tag'),el('span',item.title));
      if(item.done!==undefined) li.append(el('div',item.done?'已完成':'待完成','meta'));
      if(item.stage!==undefined) li.append(el('div',domain.stages[item.stage],'meta'));
      if(item.time) li.append(el('div',`${item.time} · ${item.place}`,'meta'));
      $('agenda').append(li);
    });
  }
  function render() {
    const focusKey=document.activeElement?.dataset.focus;
    const state=store.read();
    $('summary').replaceChildren(...domain.summary(state).map(stat=>{const node=el('div',undefined,'stat');node.append(el('strong',String(stat.value)),el('span',stat.label));return node;}));
    calendar(state);
    checklist('tasks','task-list',domain.tasks(state,$('task-filter').value));
    checklist('fitness','fitness-list',state.fitness);
    checklist('life','life-list',state.life);
    $('paper-list').replaceChildren(...state.papers.map(item=>{
      const row=el('div',undefined,'row');row.append(el('h3',item.title),el('p',`示例节点日期：${item.date}`,'meta'));
      const label=el('div',undefined,'progress-label');label.append(el('span',domain.stages[item.stage]),el('span',domain.progress(item)+'%'));
      const progress=el('progress');progress.max=100;progress.value=domain.progress(item);progress.setAttribute('aria-label',item.title+'进度');
      const button=el('button',item.stage===4?'阶段已完成':'推进一个演示阶段');button.type='button';button.disabled=item.stage===4;button.dataset.focus=item.id;
      button.addEventListener('click',()=>change('papers',item,'stage',item.stage+1));row.append(label,progress,button);return row;
    }));
    $('academic-list').replaceChildren(...state.academic.map(item=>{
      const row=el('div',undefined,'row');row.append(el('h3',item.title),el('p',`${item.date} ${item.time} · ${item.place}`,'meta'));
      const button=el('button',item.saved?'取消收藏':'收藏演示活动');button.type='button';button.dataset.focus=item.id;button.setAttribute('aria-pressed',String(item.saved));button.setAttribute('aria-label',(item.saved?'取消收藏：':'收藏：')+item.title);
      button.addEventListener('click',()=>change('academic',item,'saved',!item.saved));row.append(button);return row;
    }));
    if(focusKey){ const target=Array.from(document.querySelectorAll('[data-focus]')).find(node=>node.dataset.focus===focusKey); if(target && !target.disabled) target.focus(); else if(focusKey.startsWith('tasks-')) $('task-filter').focus(); }
  }
  function moveMonth(delta){const date=new Date(year,month+delta,1);if(date.getFullYear()<2025||date.getFullYear()>2027)return;year=date.getFullYear();month=date.getMonth();selected=dateKey(year,month,1);render();announce('已切换演示月份。');}
  $('prev-month').addEventListener('click',()=>moveMonth(-1));
  $('next-month').addEventListener('click',()=>moveMonth(1));
  $('task-filter').addEventListener('change',render);
  $('reset').addEventListener('click',()=>{store.reset();selected=window.LearningDemo.baseline;year=2026;month=9;$('task-filter').value='all';render();announce('已恢复全部虚构演示数据。');});
  render();
})();
