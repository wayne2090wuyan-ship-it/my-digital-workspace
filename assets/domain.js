/* 业务层：纯数据计算，不访问 DOM、浏览器存储或网络。 */
(function () {
  'use strict';
  const stages = ['选题','文献整理','提纲','初稿','阶段完成'];
  const labels = {tasks:'任务',papers:'论文节点',academic:'学术活动',fitness:'健身',life:'生活'};
  window.LearningDomain = Object.freeze({
    stages,
    progress(paper) { return paper.stage * 25; },
    tasks(state, filter) { return state.tasks.filter(t => filter === 'done' ? t.done : filter === 'open' ? !t.done : true); },
    events(state, date) {
      return Object.keys(labels).flatMap(key => state[key].filter(x => x.date === date).map(x => ({...x,kind:labels[key]})));
    },
    summary(state) {
      return [
        {label:'待完成任务',value:state.tasks.filter(x => !x.done).length},
        {label:'研究课题',value:state.papers.length},
        {label:'已收藏学术活动',value:state.academic.filter(x => x.saved).length},
        {label:'健身打卡',value:state.fitness.filter(x => x.done).length + ' / ' + state.fitness.length}
      ];
    }
  });
})();
