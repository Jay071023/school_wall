'use strict';

// Composition boundary: HTTP routes and jobs share the same maintenance instance.
const { pool } = require('../../config/database');
const { notifySongPlayed } = require('../../services/email');
const { createSongMaintenanceRepository } = require('../../repositories/song-maintenance');
const { createSongMaintenance } = require('../../services/song-maintenance');

const maintenance = createSongMaintenance({
  repository: createSongMaintenanceRepository(pool), notifySongPlayed
});

module.exports = { maintenance };
