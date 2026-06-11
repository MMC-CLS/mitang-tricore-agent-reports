'use strict';
const {SubAgentManager} = require('../src/subagent/subagent-manager.js');
const {SubAgentGuardian} = require('../src/subagent/subagent-guardian.js');
const {SubAgentScheduler} = require('../src/subagent/subagent-scheduler.js');
const os = require('os');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) { passed++; } else { failed++; console.log('  FAIL:', name); }
}

function getTestDir() { const d = path.join(os.tmpdir(), 'tct_' + Date.now() + '_' + Math.random().toString(36).slice(2,6)); fs.mkdirSync(d, {recursive:true}); return d; }
function cleanTestDir(d) { try { fs.rmSync(d, {recursive:true, force:true}); } catch {} }

// ── Manager Tests ──
console.log('\n[1] SubAgentManager Tests');
const d1 = getTestDir();
const mgr = new SubAgentManager({dataDir: d1, maxSubAgents: 10});

let r = mgr.create({name: 'TestAgent', type: 'assistant', description: 'test'});
assert(r.success === true, 'create returns success');
assert(r.agentId != null, 'create returns agentId');
assert(r.agent.name === 'TestAgent', 'agent name correct');
assert(mgr._agents.size === 1, 'agent count = 1');

r = mgr.create({name: 'TestAgent'});
assert(r.success === false, 'duplicate name rejected');
assert(r.error.includes('exists'), 'duplicate error message');

const {agentId: noStartId} = mgr.create({name: 'NoStart', autoStart: false});
assert(mgr._agents.get(noStartId).status === 'pending', 'no auto-start = pending');
let sr = mgr.start(noStartId);
assert(sr.success === true, 'manual start works');
sr = mgr.stop(noStartId);
assert(sr.success === true, 'stop works');
assert(mgr._agents.get(noStartId).status === 'stopped', 'status = stopped');

const {agentId: taskAid} = mgr.create({name: 'TaskAgent'});
const ar = mgr.assignTask(taskAid, {content: 'analyze data'});
assert(ar.success === true, 'assign task works');
assert(mgr._agents.get(taskAid).tasks.length === 1, 'task queue length = 1');
const cr = mgr.completeTask(taskAid, ar.taskId, {output: 'done'});
assert(cr.success === true, 'complete task works');
assert(mgr._agents.get(taskAid).tasks.length === 0, 'task queue cleared');
assert(mgr._agents.get(taskAid).performance.tasksCompleted === 1, 'tasks completed = 1');

mgr.destroy(taskAid);
assert(mgr._agents.has(taskAid) === false, 'destroy removes agent');

const list = mgr.list();
assert(list.length > 0, 'list returns agents');

const stats = mgr.getStats();
assert(stats.total > 0, 'stats has total');

mgr.close();
cleanTestDir(d1);

// ── Guardian Tests ──
console.log('\n[2] SubAgentGuardian Tests');
const d2 = getTestDir();
const mgr2 = new SubAgentManager({dataDir: d2});
const guardian = new SubAgentGuardian({subAgentManager: mgr2});

const {agentId: gaId} = mgr2.create({name: 'SafeAgent'});
let auth = guardian.authorize(gaId, 'read_data', {});
assert(auth.allowed === true, 'allow read operation');

auth = guardian.authorize(gaId, 'set_config', {key:'test'});
assert(auth.allowed === false, 'block config modification');
assert(auth.reason.includes('config'), 'iron law 1 message');

auth = guardian.authorize(gaId, 'execute_shell', {cmd:'rm'});
assert(auth.allowed === false, 'block system operation');

const {agentId: hiId} = mgr2.create({name: 'HighSec', safetyLevel: 'high'});
auth = guardian.authorize(hiId, 'delete', {target:'file'});
assert(auth.allowed === false, 'high safety blocks delete');

guardian._lockdownAgents.add(gaId);
auth = guardian.authorize(gaId, 'read_data', {});
assert(auth.allowed === false, 'quarantined agent blocked');
guardian._lockdownAgents.delete(gaId);

mgr2.destroy(gaId);
mgr2.destroy(hiId);
guardian.close();
mgr2.close();
cleanTestDir(d2);

// ── Scheduler Tests ──
console.log('\n[3] SubAgentScheduler Tests');
const d3 = getTestDir();
const mgr3 = new SubAgentManager({dataDir: d3});
const sched = new SubAgentScheduler({subAgentManager: mgr3, strategy: 'least_loaded'});

let tr = sched.submitTask({content: 'test', priority: 2});
assert(tr.success === true, 'submit task works');
assert(sched._taskQueue.length === 1, 'task queue = 1');

sched.submitTask({content: 'high', priority: 3});
sched.submitTask({content: 'low', priority: 0});
assert(sched._taskQueue[0].priority === 3, 'priority sort works');

tr = sched.submitCompositeTask({
  mainGoal: 'composite',
  subtasks: [{content: 'sub1'}, {content: 'sub2'}]
});
assert(tr.success === true, 'composite task works');
assert(tr.tasks.length === 2, '2 subtasks');

const {agentId: schedId} = mgr3.create({name: 'SchedAgent', type: 'executor'});
sched.submitTask({content: 'to_assign'});
sched._trySchedule();
assert(sched._activeTasks.size === 1, 'task auto-assigned');

const activeTask = sched._activeTasks.values().next().value;
const completeResult = sched.completeTask(activeTask.id, {output: 'ok'});
assert(completeResult.success === true, 'complete scheduled task');

const {taskId: cancelId} = sched.submitTask({content: 'cancel_me'});
const cancelResult = sched.cancelTask(cancelId);
assert(cancelResult.success === true, 'cancel task works');

mgr3.destroy(schedId);
sched.close();
mgr3.close();
cleanTestDir(d3);

console.log('\n========================================');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('========================================');
if (failed > 0) process.exit(1);
