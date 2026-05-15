var Client = require('ssh2').Client;
var fs = require('fs');
var conn = new Client();
conn.on('ready', function() {
  conn.exec('cat /root/.pm2/logs/campus-wall-error.log 2>/dev/null | tail -20', function(err, stream) {
    if (err) { console.log('Error:', err.message); conn.end(); return; }
    var d = '';
    stream.on('data', function(c) { d += c; });
    stream.on('close', function() {
      console.log(d || '(empty)');
      // also check out log
      conn.exec('cat /root/.pm2/logs/campus-wall-out.log 2>/dev/null | grep -i "\\[AI\\]\\|MiniMax" | tail -10', function(err2, s2) {
        var d2 = '';
        s2.on('data', function(c) { d2 += c; });
        s2.on('close', function() { console.log('---OUT---');console.log(d2 || '(empty)'); conn.end(); });
      });
    });
  });
});
conn.connect({
  host: '152.32.226.134', port: 22, username: 'root',
  privateKey: fs.readFileSync('d:\\D盘的桌面\\校墙\\ssh_key_new')
});
