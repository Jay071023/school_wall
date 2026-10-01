'use strict';
const path = require('path');
const dotenv = require('dotenv');

function loadEnvironment(root = path.resolve(__dirname, '..')) {
  dotenv.config({ path: path.join(root, '.env') });
  dotenv.config({ path: path.join(root, '.env.local'), override: true });
}

module.exports = { loadEnvironment };
