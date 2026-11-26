const { updateNotification } = require('../notify');

updateNotification(process.env.INPUT_MODE ?? process.env.MODE);
