'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
function checkpoint() {
  const state=context.getStore();
  if (!state) return;
  if (state.signal.aborted || Date.now() >= state.deadline) throw Object.assign(new Error(state.signal.aborted ? 'Operation cancelled before the next commit' : 'Operation deadline exceeded'), {code:state.signal.aborted?'OPERATION_CANCELLED':'OPERATION_TIMEOUT'});
}
module.exports={context,checkpoint};
