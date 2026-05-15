const express = require('express');
const router = express.Router();
const https = require('https');

// 历史上的今天
router.get('/', async (req, res) => {
  var timeout = setTimeout(function() {
    res.json({ code: 200, data: [] });
  }, 3000);

  try {
    var today = new Date();
    var month = String(today.getMonth() + 1).padStart(2, '0');
    var day = String(today.getDate()).padStart(2, '0');

    https.get('https://baike.baidu.com/api/whw/' + month + day, function(response) {
      var data = '';
      response.on('data', function(chunk) { data += chunk; });
      response.on('end', function() {
        clearTimeout(timeout);
        try {
          var parsed = JSON.parse(data);
          res.json({ code: 200, data: parsed && parsed.list ? parsed.list : [] });
        } catch (e) {
          res.json({ code: 200, data: [] });
        }
      });
    }).on('error', function() {
      clearTimeout(timeout);
      res.json({ code: 200, data: [] });
    });
  } catch (err) {
    clearTimeout(timeout);
    res.json({ code: 200, data: [] });
  }
});

module.exports = router;
