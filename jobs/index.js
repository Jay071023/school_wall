'use strict';

const { scheduleCleanup, drainCleanup } = require('../services/cleanup');
const auth = require('../routes/auth');
const posts = require('../routes/posts');
const songs = require('../routes/songs');
const mp = require('../routes/mp-draft');

let stop = null;

function startBackgroundTasks() {
  if (stop) return stop;
  const stoppers = [];
  try {
    stoppers.push(auth.startCaptchaCleanup());
    stoppers.push(posts.startLikeDebounceCleanup());
    stoppers.push(songs.startBackgroundTasks());
    stoppers.push(mp.startSyncCleanup());
    stoppers.push(scheduleCleanup());
  } catch (error) {
    stoppers.reverse().forEach(stopper => { Promise.resolve(stopper()).catch(() => {}); });
    throw error;
  }
  let stopping;
  stop = function stopBackgroundTasks() {
    if (stopping) return stopping;
    stop = null;
    stopping = Promise.all(stoppers.reverse().map(stopper => stopper()));
    return stopping;
  };
  return stop;
}

async function drainBackgroundTasks() {
  await Promise.all([drainCleanup(), songs.drainBackgroundTasks(), mp.drainBackgroundTasks()]);
}

module.exports = { startBackgroundTasks, drainBackgroundTasks };
