'use strict';
const { createIntervalTask } = require('./task-lifecycle');
const { parseBoundedPositiveInt } = require('./number-utils');
const { getChinaDate, getChinaJsDayOfWeek, getChinaTime, getChinaDayRange } = require('./date');

function createSongMaintenance({ repository, notifySongPlayed, now = () => new Date(), logger = console }) {
  const AUTO_PLAY_REFRESH_MS = 60 * 1000;
  let autoPlayTask = null;
  let stop = null;
  const notifications = new Set();
  async function markDueApprovedSongsAsPlayed() {
    if (autoPlayTask) return autoPlayTask;
    autoPlayTask = (async () => {
      const currentTime = now();
      const today = getChinaDate(0, currentTime);
      const nowTime = getChinaTime(currentTime);
      const dueSongs = await repository.findDueSongs(today, nowTime);
      const playedSongs = [];
      for (const song of dueSongs) {
        if (await repository.markPlayed(song.id)) playedSongs.push(song);
      }
      if (playedSongs.length > 0) {
        const notification = new Promise(resolve => setImmediate(resolve)).then(async () => {
          for (const song of playedSongs) {
            if (!song.email) continue;
            try {
              await notifySongPlayed(song.email, song.nickname || song.username || '用户', song.song_name || '未知', song.artist || '未知', song.user_id);
            } catch (err) {
              logger.error('[Songs] 自动播放通知失败:', err.message);
            }
          }
        });
        notifications.add(notification);
        notification.then(() => notifications.delete(notification), () => notifications.delete(notification));
        logger.log(`[Songs] 已自动标记 ${playedSongs.length} 首点歌为已播放`);
      }
      return playedSongs.length;
    })().catch(err => {
      logger.error('[Songs] 自动标记已播放失败:', err.message);
      return 0;
    }).finally(() => {
      autoPlayTask = null;
    });
    return autoPlayTask;
  }

  const autoPlaybackTask = createIntervalTask(markDueApprovedSongsAsPlayed, AUTO_PLAY_REFRESH_MS, { initialDelayMs: 8000 });

  // 自动补充未来日期（当天~14天后）。同一时间只允许一个补充任务，
  // 避免多个手机/后台请求同时逐条写入同一批日期。
  let futureDatesTask = null;
  let futureDatesTimer = null;
  let stopFutureDatesMaintenance = null;
  const FUTURE_DATES_INITIAL_DELAY_MS = 5000;
  const FUTURE_DATES_REFRESH_MS = 60 * 60 * 1000;
  const FUTURE_DATES_RETRY_MS = 60 * 1000;

  async function populateFutureDates() {
    try {
      const { slots, hasSlotCapacity } = await repository.findActiveSlots();
      if (slots.length === 0) return true;
      const todayNow = now();
      const { today, rangeEnd } = getChinaDayRange(todayNow);

      // “每人每日点歌上限”是用户级限制，不能用来覆盖播放时段容量。
      // 优先读取每个时段最近的非单日例外容量，避免自动维护改写管理员的时段设置。
      const capacityRows = await repository.findFutureCapacities(today);
      const slotCapacityById = new Map();
      for (const slot of slots) {
        const configuredCapacity = hasSlotCapacity && Number(slot.max_songs) > 0
          ? parseBoundedPositiveInt(slot.max_songs, 10, 100)
          : null;
        if (configuredCapacity) slotCapacityById.set(slot.id, configuredCapacity);
      }
      for (const row of capacityRows) {
        if (slotCapacityById.has(row.slot_id) || Number(row.manual_override) === 1) continue;
        const capacity = parseBoundedPositiveInt(row.max_songs, 10, 100);
        slotCapacityById.set(row.slot_id, capacity);
      }

      const dateRows = [];
      for (let i = 0; i < 14; i++) {
        const dateStr = getChinaDate(i, todayNow);
        const dayOfWeek = getChinaJsDayOfWeek(dateStr);
        for (const slot of slots) {
          const effectiveStartDate = slot.effective_start_date
            ? String(slot.effective_start_date).split('T')[0]
            : '';
          if (effectiveStartDate && dateStr < effectiveStartDate) {
            continue;
          }
          // 如果时段设置了周周期，检查当前日期是否在允许的范围内
          if (slot.weekdays && slot.weekdays !== '') {
            const allowedDays = slot.weekdays.split(',').map(w => parseInt(w));
            if (!allowedDays.includes(dayOfWeek)) {
              continue; // 跳过不在允许范围内的日期
            }
          }
          dateRows.push([slot.id, dateStr, slotCapacityById.get(slot.id) || 10]);
        }
      }

      // 一次最多写入 200 行，减少 14 × 时段数次网络往返，同时保留批次上限。
      for (let start = 0; start < dateRows.length; start += 200) {
        const batch = dateRows.slice(start, start + 200);
        await repository.insertDates(batch);
      }
      await repository.pruneDates(today, rangeEnd);
      return true;
    } catch (e) {
      logger.error('[时段] 自动补充日期失败:', e.message);
      return false;
    }
  }

  function ensureFutureDates() {
    if (!futureDatesTask) {
      futureDatesTask = populateFutureDates().finally(() => {
        futureDatesTask = null;
      });
    }
    return futureDatesTask;
  }

  // 由任务入口显式启动；成功后按周期运行，失败则短间隔重试。
  // 任务完全异步且定时器 unref，不阻塞服务启动或阻止进程退出。
  function startFutureDatesMaintenance() {
    if (stopFutureDatesMaintenance) return stopFutureDatesMaintenance;
    let active = true;

    let run;
    const scheduleNext = delay => {
      if (!active) return;
      futureDatesTimer = setTimeout(run, delay);
      if (typeof futureDatesTimer.unref === 'function') futureDatesTimer.unref();
    };

    run = () => {
      futureDatesTimer = null;
      ensureFutureDates()
        .then(success => scheduleNext(success ? FUTURE_DATES_REFRESH_MS : FUTURE_DATES_RETRY_MS))
        .catch(error => {
          logger.error('[时段] 后台维护任务失败:', error.message);
          scheduleNext(FUTURE_DATES_RETRY_MS);
        });
    };

    scheduleNext(FUTURE_DATES_INITIAL_DELAY_MS);
    stopFutureDatesMaintenance = function stopMaintenance() {
      if (active) {
        active = false;
        clearTimeout(futureDatesTimer);
        futureDatesTimer = null;
        stopFutureDatesMaintenance = null;
      }
      return futureDatesTask || Promise.resolve();
    };
    return stopFutureDatesMaintenance;
  }

  function start() {
    if (stop) return stop;
    const stopPlayback = autoPlaybackTask.start();
    const stopDates = startFutureDatesMaintenance();
    let stopping;
    stop = () => {
      if (stopping) return stopping;
      stop = null;
      stopping = Promise.all([stopPlayback(), stopDates()]);
      return stopping;
    };
    return stop;
  }

  async function drain() {
    await Promise.all([autoPlayTask, futureDatesTask]);
    await Promise.allSettled([...notifications]);
  }

  return { ensureFutureDates, markDueApprovedSongsAsPlayed, start, drain };
}

module.exports = { createSongMaintenance };
