#!/bin/bash
# keep-alive 守护:确保 Go 服务持续监听 3001

LOG=/tmp/keepalive.log
echo "[$(date)] Keepalive daemon started" >> "$LOG"

while true; do
  # 检查 3001 端口是否在监听
  LISTENING=$(/bin/cat /proc/net/tcp 2>/dev/null | /usr/bin/awk 'NR>1 {if($2~/0BB9/ && $4=="0A") print "yes"; if($2~/0BB9/ && $4!="0A") print "no"}' | /usr/bin/head -1)

  if [ "$LISTENING" != "yes" ]; then
    echo "[$(date)] Port 3001 not LISTENING. Restarting Go..." >> "$LOG"
    # 检查是否为 listen tcp 冲突
    LISTEN_3001_TIMES=$(/bin/cat /proc/net/tcp 2>/dev/null | /usr/bin/awk 'NR>1 {if($2~/0BB9/) print $4}' | /usr/bin/sort | /usr/bin/uniq -c)
    echo "[$(date)] States: $LISTEN_3001_TIMES" >> "$LOG"

    # 如果有别的进程占着,杀掉
    for p in $(/bin/ls /proc 2>/dev/null | /usr/bin/grep -E "^[0-9]+$"); do
      n=$(/bin/cat /proc/$p/comm 2>/dev/null)
      if [ "$n" = "campus-wall" ]; then
        /usr/bin/kill -9 $p 2>/dev/null
      fi
    done
    sleep 2

    # 启动 PM2
    PATH=/usr/local/bin:/usr/bin /usr/bin/pm2 delete campus-wall-go 2>/dev/null
    cd /www/wwwroot/wall.jay23.cn/campus-wall-go
    PATH=/usr/local/bin:/usr/bin /usr/bin/pm2 start ecosystem.config.js >> "$LOG" 2>&1
    echo "[$(date)] PM2 restarted" >> "$LOG"
  fi

  sleep 30
done
